import { useState } from "react"
import { App, Button, Checkbox, Form, Input } from "antd"
import { SafetyCertificateOutlined } from "@ant-design/icons"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useConsole } from "../state"
import { useTheme } from "../theme"
import { ThemeToggle } from "../components/ThemeToggle"

// 移动端进入页面时不自动聚焦，避免立即弹出软键盘。
const autoFocus = typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches

/** 登录页面：只承担验证码登录这一项任务。 */
export default function Login() {
  const { login, requestCode, meta, overview, error } = useConsole()
  const { message } = App.useApp()
  const { dark } = useTheme()
  const [submitting, setSubmitting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [failure, setFailure] = useState("")
  const reduced = useReducedMotion()
  const days = overview?.panel?.trustedDeviceTtlDays ?? meta?.auth?.trustedDeviceTtlDays ?? 30
  const shown = failure || error

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
      message.success("验证码已打印到宿主终端")
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "获取失败")
    } finally {
      setRequesting(false)
    }
  }

  return (
    <div className="login-screen">
      <header className="login-header">
        <div className="login-brand">
          <span className="brand-mark">
            <SafetyCertificateOutlined />
          </span>
          <span className="login-brand-name">Yunzai Guard</span>
          <span className="login-brand-note">TRSS-Yunzai 安全防护</span>
        </div>
        <ThemeToggle dark={dark} />
      </header>

      <motion.main
        className="login-main"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <section className="login-card">
          <h1>登录控制台</h1>
          <p>使用宿主终端中的一次性验证码</p>
          <Form
            layout="vertical"
            onFinish={submit}
            initialValues={{ remember: true }}
            requiredMark={false}
          >
            <div className="login-label">
              <label htmlFor="code">验证码</label>
              <span>5 分钟内有效</span>
            </div>
            <Form.Item
              name="code"
              rules={[{ required: true, message: "请输入 16 位验证码" }]}
              className="login-code-item"
            >
              <Input
                id="code"
                placeholder="输入 16 位验证码"
                maxLength={16}
                autoComplete="one-time-code"
                spellCheck={false}
                autoFocus={autoFocus}
                status={shown ? "error" : undefined}
                className="code-input"
              />
            </Form.Item>
            <AnimatePresence initial={false}>
              {shown && (
                <motion.div
                  key={shown}
                  className="login-error"
                  role="alert"
                  initial={reduced ? false : { opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduced ? 0 : 0.16 }}
                >
                  {shown}
                </motion.div>
              )}
            </AnimatePresence>
            <Form.Item name="remember" valuePropName="checked" className="login-remember">
              <Checkbox>信任此设备（{days} 天）</Checkbox>
            </Form.Item>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={submitting}
              className="login-submit"
            >
              {submitting ? "正在验证…" : "验证并登录"}
            </Button>
            <Button
              type="text"
              block
              onClick={generate}
              loading={requesting}
              className="login-request"
            >
              {requesting ? "正在获取…" : "重新获取验证码"}
            </Button>
          </Form>
        </section>
        <aside className="login-alternative">
          <strong>QQ 登录</strong>
          <span>
            向机器人发送 <code>#guard登录</code>，获取一次性登录链接。
          </span>
        </aside>
      </motion.main>
    </div>
  )
}
