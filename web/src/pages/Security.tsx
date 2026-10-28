import { useCallback, useEffect, useState } from "react"
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Switch,
  Space,
  Table,
  Tag,
} from "antd"
import type { TableColumnsType } from "antd"
import { ReloadOutlined } from "@ant-design/icons"
import { api } from "../api"
import { useConsole } from "../state"
import { formatTime } from "../components"
import { FieldLabel } from "../components/FieldHelp"

/** 安全中心页面：会话与可信设备。 */
export default function Security() {
  const { session, overview, logout, reload, saving: guardSaving } = useConsole()
  const { message } = App.useApp()
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState(false)
  const [form] = Form.useForm()
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api("/api/security/sessions")
      setSessions(result.sessions ?? [])
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setLoading(false)
    }
  }, [message])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (form.isFieldsTouched()) return
    const panel = overview?.panel ?? {}
    form.setFieldsValue({
      host: panel.host ?? "127.0.0.1",
      port: panel.port ?? 21733,
      tokenTtlHours: panel.tokenTtlHours ?? 24,
      trustedDeviceTtlDays: panel.trustedDeviceTtlDays ?? 30,
      allowExternal: panel.allowExternal === true,
    })
  }, [overview, form])
  const revoke = async (item: any) => {
    try {
      if (item.current) await logout()
      else {
        await api(`/api/security/sessions/${encodeURIComponent(item.id)}`, { method: "DELETE" })
        await load()
        message.success("已撤销")
      }
    } catch (error) {
      message.error((error as Error).message)
    }
  }
  const columns: TableColumnsType<any> = [
    {
      title: "设备",
      dataIndex: "name",
      width: 210,
      render: (value, item) => (
        <Space wrap>
          {value}
          {item.current && <Tag color="blue">当前设备</Tag>}
        </Space>
      ),
    },
    {
      title: "会话",
      dataIndex: "remembered",
      width: 110,
      render: value => (
        <Tag color={value ? "green" : undefined}>{value ? "可信设备" : "临时会话"}</Tag>
      ),
    },
    {
      title: "登录时间",
      dataIndex: "createdAt",
      render: value => <span className="mono">{formatTime(value, true)}</span>,
      width: 180,
    },
    {
      title: "最近活动",
      dataIndex: "lastSeen",
      render: value => <span className="mono">{formatTime(value, true)}</span>,
      width: 180,
    },
    {
      title: "到期时间",
      dataIndex: "expiresAt",
      render: value => <span className="mono">{formatTime(value, true)}</span>,
      width: 180,
    },
    {
      title: "",
      width: 80,
      render: (_, item) => (
        <Popconfirm
          title={item.current ? "退出当前设备？" : "撤销这台设备？"}
          okText={item.current ? "退出" : "撤销"}
          cancelText="取消"
          onConfirm={() => revoke(item)}
        >
          <Button danger type="text">
            {item.current ? "退出" : "撤销"}
          </Button>
        </Popconfirm>
      ),
    },
  ]
  const save = async (values: any) => {
    setSaving(true)
    try {
      const result = await api("/api/panel", { method: "POST", body: JSON.stringify(values) })
      setPending(Boolean(result.restartRequired))
      await reload(true)
      message.success("已保存")
    } catch (error) {
      message.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="page-stack security-page">
      <Card title="当前会话" className="setting-section">
        <Descriptions
          column={{ xs: 1, sm: 2, lg: 4 }}
          size="small"
          items={[
            { key: "identity", label: "身份", children: session?.username ?? "管理员" },
            { key: "method", label: "登录方式", children: "验证码" },
            {
              key: "device",
              label: "设备状态",
              children: <Tag color="blue">{session?.remembered ? "已信任" : "临时"}</Tag>,
            },
            { key: "expires", label: "到期时间", children: formatTime(session?.expiresAt, true) },
          ]}
        />
      </Card>
      <Card
        title="设备会话"
        className="table-card"
        extra={<Button icon={<ReloadOutlined />} aria-label="刷新设备" onClick={load} />}
      >
        <Table
          rowKey="id"
          columns={columns}
          dataSource={sessions}
          loading={loading}
          pagination={false}
          scroll={{ x: 940 }}
          className="compact-table"
        />
      </Card>
      <Card
        title="面板设置"
        className="setting-section"
        extra={
          (overview?.panel?.restartRequired ?? pending) ? (
            <Tag color="orange">需重启</Tag>
          ) : undefined
        }
      >
        <Form
          form={form}
          className="settings-form panel-settings-form"
          layout="horizontal"
          labelCol={{ flex: "140px" }}
          onFinish={save}
          disabled={saving || guardSaving}
          requiredMark={false}
        >
          <Form.Item
            name="host"
            label={<FieldLabel helpKey="panel.host">监听地址</FieldLabel>}
            rules={[{ required: true }]}
            className="setting-row"
          >
            <Input className="setting-input" />
          </Form.Item>
          <Form.Item
            name="port"
            label={<FieldLabel helpKey="panel.port">面板端口</FieldLabel>}
            rules={[{ required: true }]}
            className="setting-row"
          >
            <InputNumber min={1024} max={65535} precision={0} className="setting-number" />
          </Form.Item>
          <Form.Item
            name="tokenTtlHours"
            label={<FieldLabel helpKey="panel.tokenTtlHours">临时会话有效期</FieldLabel>}
            rules={[{ required: true }]}
            className="setting-row"
          >
            <InputNumber
              min={1}
              max={720}
              precision={0}
              addonAfter="小时"
              className="setting-number setting-number-unit"
            />
          </Form.Item>
          <Form.Item
            name="trustedDeviceTtlDays"
            label={<FieldLabel helpKey="panel.trustedDeviceTtlDays">可信设备有效期</FieldLabel>}
            rules={[{ required: true }]}
            className="setting-row"
          >
            <InputNumber
              min={1}
              max={90}
              precision={0}
              addonAfter="天"
              className="setting-number setting-number-unit"
            />
          </Form.Item>
          <Form.Item
            name="allowExternal"
            label={<FieldLabel helpKey="panel.allowExternal">允许外网访问</FieldLabel>}
            valuePropName="checked"
            className="setting-row"
          >
            <Switch />
          </Form.Item>
          <Form.Item className="setting-row setting-submit-row">
            <Button type="primary" htmlType="submit" loading={saving} disabled={guardSaving}>
              保存面板设置
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
