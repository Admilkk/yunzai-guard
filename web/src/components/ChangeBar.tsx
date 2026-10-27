import { useEffect, useState } from "react"
import { App, Button, Drawer, Space, Table, Tag, Typography } from "antd"
import { DiffOutlined, SaveOutlined, UndoOutlined } from "@ant-design/icons"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useConsole } from "../state"
import { formatChange, type ConfigChange } from "../lib/diff"

/** 未保存修改提示条，提供保存与放弃。 */
export function ChangeBar() {
  const ctx = useConsole()
  const { modal } = App.useApp()
  const [open, setOpen] = useState(false)
  const reduced = useReducedMotion()
  useEffect(() => {
    if (!ctx.dirty) setOpen(false)
  }, [ctx.dirty])
  return (
    <>
      <AnimatePresence initial={false}>
        {ctx.dirty && (
          <motion.div
            className="change-bar"
            role="region"
            aria-label="配置更改"
            initial={reduced ? false : { opacity: 0, y: 14, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.99 }}
            transition={{ duration: reduced ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
          >
            <Space size={10} className="change-summary">
              <Typography.Text strong>待保存更改</Typography.Text>
              <Tag>{ctx.changes.length} 项</Tag>
            </Space>
            <Space size={8} wrap className="change-actions">
              <Button icon={<DiffOutlined />} onClick={() => setOpen(true)}>
                查看变更
              </Button>
              <Button
                icon={<UndoOutlined />}
                disabled={ctx.saving}
                onClick={() =>
                  modal.confirm({
                    title: "放弃全部未保存更改？",
                    okText: "放弃更改",
                    okButtonProps: { danger: true },
                    cancelText: "继续编辑",
                    onOk: ctx.reset,
                  })
                }
              >
                放弃更改
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={ctx.saving}
                onClick={() => void ctx.save()}
              >
                保存全部更改
              </Button>
            </Space>
          </motion.div>
        )}
      </AnimatePresence>
      <Drawer
        title={`待保存更改 · ${ctx.changes.length} 项`}
        open={open && ctx.dirty}
        onClose={() => setOpen(false)}
        size={760}
        className="changes-drawer"
      >
        <Table<ConfigChange>
          rowKey="path"
          dataSource={ctx.changes}
          size="small"
          scroll={{ x: 680 }}
          pagination={{ pageSize: 12, hideOnSinglePage: true }}
          columns={[
            {
              title: "配置项",
              dataIndex: "path",
              width: 250,
              render: (value, item) => (
                <Space size={6}>
                  <span className="mono">{value}</span>
                  {item.invalid && <Tag color="red">JSON 无效</Tag>}
                  {item.limited && <Tag color="orange">预览受限</Tag>}
                </Space>
              ),
            },
            {
              title: "已保存",
              dataIndex: "before",
              render: value => (
                <Typography.Text
                  className="change-value"
                  ellipsis={{ tooltip: formatChange(value) }}
                >
                  {formatChange(value)}
                </Typography.Text>
              ),
            },
            {
              title: "草稿",
              dataIndex: "after",
              render: value => (
                <Typography.Text
                  className="change-value"
                  ellipsis={{ tooltip: formatChange(value) }}
                >
                  {formatChange(value)}
                </Typography.Text>
              ),
            },
          ]}
        />
      </Drawer>
    </>
  )
}
