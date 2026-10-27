import { useState } from "react"
import { App, Button, Checkbox, Form, Input, Typography } from "antd"
import { KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons"
import { motion, useReducedMotion } from "motion/react"
import { useConsole } from "../state"

/** 登录页面。 */
export default function Login() {
  const { login, requestCode, meta, overview, error } = useConsole()
  const { message } = App.useApp()
  const [submitting, setSubmitting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [failure, setFailure] = useState("")
  const reduced = useReducedMotion()
  const days = overview?.panel?.trustedDeviceTtlDays ?? meta?.auth?.trustedDeviceTtlDays ?? 30

  /** 提交验证码登录。 */
  async function submit(values: { code: string; remember: boolean }) {
    setSubmitting(true)
    setFailure("")
    try {
      await login(values.code, values.remember)
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : "登录失败")
    } finally {
      setSubmitting(false)
    }
  }

  /** 请求生成新的验证码。 */
  async function generate() {
    setRequesting(true)
    try {
      await requestCode()
      message.success("验证码已生成")
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "获取失败")
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div className="login-screen">
      <motion.div
        className="login-panel"
        initial={reduced ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24 }}
      >
        <div className="login-brand">
          <SafetyCertificateOutlined />
          <span>Guard</span>
        </div>
        <Form
          layout="vertical"
          onFinish={submit}
          initialValues={{ remember: true }}
          requiredMark={false}
        >
          <Form.Item
            name="code"
            label="控制台验证码"
            rules={[{ required: true, message: "请输入验证码" }]}
          >
            <Input
              prefix={<KeyOutlined />}
              maxLength={16}
              autoComplete="one-time-code"
              size="large"
              className="code-input"
            />
          </Form.Item>
          <Form.Item name="remember" valuePropName="checked">
            <Checkbox>信任此设备 · {days} 天</Checkbox>
          </Form.Item>
          {(failure || error) && (
            <Typography.Text className="login-error" type="danger">
              {failure || error}
            </Typography.Text>
          )}
          <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
            登录
          </Button>
          <Button
            size="large"
            block
            onClick={generate}
            loading={requesting}
            className="request-code"
          >
            获取验证码
          </Button>
        </Form>
      </motion.div>
    </div>
  )
}
