import { useCallback, useEffect, useRef, useState } from "react"
import { App, Button, Empty, Modal, Popconfirm, Radio, Space, Table, Typography } from "antd"
import { DownloadOutlined, UploadOutlined } from "@ant-design/icons"
import { api } from "../api"
import { formatBytes, formatTime, PanelCard } from "../components"
import { useConsole } from "../state"

type Backup = { id: string; time: number; size: number }

/** 下载接口返回的文件。 */
async function download(path: string, fallback: string) {
  const response = await fetch(path, { credentials: "same-origin" })
  if (!response.ok) throw new Error(`下载失败（${response.status}）`)
  const name =
    /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? fallback
  const url = URL.createObjectURL(await response.blob())
  const link = Object.assign(document.createElement("a"), { href: url, download: name })
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 配置的历史备份、回滚、导出与规则导入。 */
export function BackupCard() {
  const { message } = App.useApp()
  const { reload, dirty, saving } = useConsole()
  const [backups, setBackups] = useState<Backup[]>([])
  const [preview, setPreview] = useState<{ id: string; text: string }>()
  const [imported, setImported] = useState<{ rules: unknown[]; name: string }>()
  const [mode, setMode] = useState<"append" | "replace">("append")
  const input = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      setBackups((await api("/api/settings/backups")).backups ?? [])
    } catch {
      setBackups([])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 查看一份备份的内容。 */
  async function open(id: string) {
    try {
      const result = await api(`/api/settings/backup?id=${encodeURIComponent(id)}`)
      setPreview({ id, text: JSON.stringify(result.document, null, 2) })
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "读取失败")
    }
  }

  /** 回滚到指定备份；当前配置会先被备份。 */
  async function restore(id: string) {
    try {
      await api("/api/settings/restore", { method: "POST", body: JSON.stringify({ id }) })
      message.success("已恢复，并按字段自动应用")
      setPreview(undefined)
      await Promise.all([load(), reload(true)])
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "恢复失败")
    }
  }

  /** 读取导入的规则文件：接受完整配置或只含 rules 的文件。 */
  async function choose(file: File) {
    try {
      const value = JSON.parse(await file.text())
      const rules = Array.isArray(value) ? value : value?.rules
      if (!Array.isArray(rules)) throw new Error("文件里没有 rules 数组")
      setImported({ rules, name: file.name })
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "无法读取文件")
    }
  }

  /** 提交导入的规则。 */
  async function confirmImport() {
    if (!imported) return
    try {
      const result = await api("/api/settings/import-rules", {
        method: "POST",
        body: JSON.stringify({ rules: imported.rules, mode }),
      })
      message.success(`已导入 ${result.imported} 条规则`)
      setImported(undefined)
      await Promise.all([load(), reload(true)])
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "导入失败")
    }
  }

  return (
    <PanelCard
      title="备份与迁移"
      extra={
        <Space size={8} wrap>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() =>
              void download("/api/settings/export", "guard-settings.json").catch(error =>
                message.error(error.message),
              )
            }
          >
            导出配置
          </Button>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            onClick={() =>
              void download("/api/settings/export?scope=rules", "guard-rules.json").catch(error =>
                message.error(error.message),
              )
            }
          >
            导出规则
          </Button>
          <Button
            size="small"
            icon={<UploadOutlined />}
            disabled={dirty || saving}
            onClick={() => input.current?.click()}
          >
            导入规则
          </Button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={event => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (file) void choose(file)
            }}
          />
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" className="card-note">
        每次保存前会自动备份当前配置，保留最近 30 份。导出的配置默认不含 Webhook
        密钥，可分享规则文件给其他实例导入。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        dataSource={backups}
        pagination={{ pageSize: 8, hideOnSinglePage: true }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有备份，保存过一次配置后出现"
            />
          ),
        }}
        columns={[
          { title: "时间", dataIndex: "time", render: value => formatTime(value, true) },
          { title: "大小", dataIndex: "size", width: 90, render: formatBytes },
          {
            title: "",
            width: 150,
            render: (_, item) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => void open(item.id)}>
                  查看
                </Button>
                <Popconfirm
                  title="恢复到这份配置？当前配置会先自动备份。"
                  onConfirm={() => void restore(item.id)}
                  okText="恢复"
                  cancelText="取消"
                >
                  <Button size="small" type="link" disabled={dirty || saving}>
                    恢复
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={Boolean(preview)}
        title={preview ? `备份 ${preview.id}` : ""}
        onCancel={() => setPreview(undefined)}
        width={720}
        footer={
          <Space>
            <Button onClick={() => setPreview(undefined)}>关闭</Button>
            <Button
              type="primary"
              disabled={dirty || saving}
              onClick={() => preview && void restore(preview.id)}
            >
              恢复到这份
            </Button>
          </Space>
        }
      >
        <pre className="backup-preview">{preview?.text}</pre>
      </Modal>
      <Modal
        open={Boolean(imported)}
        title={`导入 ${imported?.rules.length ?? 0} 条规则`}
        onCancel={() => setImported(undefined)}
        onOk={() => void confirmImport()}
        okText="导入"
        cancelText="取消"
      >
        <p className="muted">来自 {imported?.name}。导入前会自动备份当前配置，规则会经过校验。</p>
        <Radio.Group value={mode} onChange={event => setMode(event.target.value)}>
          <Space direction="vertical">
            <Radio value="append">追加到现有规则之后（重名自动改名）</Radio>
            <Radio value="replace">替换全部现有规则</Radio>
          </Space>
        </Radio.Group>
      </Modal>
    </PanelCard>
  )
}
