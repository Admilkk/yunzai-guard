import { useState } from "react"
import { App, Button, Checkbox, ConfigProvider, Form, Input, Typography, theme } from "antd"
import { ArrowRightOutlined, KeyOutlined, SafetyCertificateOutlined } from "@ant-design/icons"
import { motion, useReducedMotion, type Variants } from "motion/react"
import { useConsole } from "../state"

// 登录页始终是深色，不跟随控制台主题。
const loginTheme = {
  inherit: false,
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#3ccf9f",
    colorTextLightSolid: "#04120d",
    colorBgContainer: "#ffffff08",
    colorBorder: "#ffffff1f",
    colorText: "#e8f0ec",
    colorTextSecondary: "#8fa39b",
    borderRadius: 10,
    fontSize: 13,
    controlHeightLG: 46,
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: { Button: { primaryShadow: "0 10px 30px -12px #3ccf9fcc", fontWeight: 600 } },
}

// 雷达上的光点：位置固定，仅作装饰。
const blips = [
  { x: 62, y: 28, tone: "ok", delay: 0.4 },
  { x: 30, y: 40, tone: "ok", delay: 1.6 },
  { x: 72, y: 66, tone: "bad", delay: 2.3 },
  { x: 40, y: 74, tone: "ok", delay: 3.1 },
  { x: 22, y: 60, tone: "ok", delay: 0.9 },
]

const stagger: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.08, delayChildren: 0.1 } },
}
const rise: Variants = {
  hidden: { opacity: 0, y: 18, filter: "blur(6px)" },
  shown: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] },
  },
}

/** 登录页面。 */
export default function Login() {
  const { login, requestCode, meta, overview, error } = useConsole()
  const { message } = App.useApp()
  const [submitting, setSubmitting] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [failure, setFailure] = useState("")
  const reduced = useReducedMotion()
  const days = overview?.panel?.trustedDeviceTtlDays ?? meta?.auth?.trustedDeviceTtlDays ?? 30
  const initial = reduced ? "shown" : "hidden"

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
    <ConfigProvider theme={loginTheme}>
      <div className="login-screen">
        <div className="login-aurora" aria-hidden>
          <i />
          <i />
          <i />
        </div>
        <div className="login-grid" aria-hidden />
        <motion.main className="login-layout" variants={stagger} initial={initial} animate="shown">
          <section className="login-hero">
            <motion.div className="login-brand" variants={rise}>
              <span className="brand-mark">
                <SafetyCertificateOutlined />
              </span>
              Yunzai Guard
            </motion.div>
            <motion.h1 variants={rise}>
              看住
              <br />
              每一个插件。
            </motion.h1>
            <motion.p variants={rise}>审计 · 拦截 · 完整性校验</motion.p>
            <motion.div className="login-radar" variants={rise} aria-hidden>
              <span className="radar-ring" />
              <span className="radar-ring" />
              <span className="radar-ring" />
              <span className="radar-sweep" />
              <span className="radar-core">
                <SafetyCertificateOutlined />
              </span>
              {blips.map(item => (
                <span
                  key={`${item.x}-${item.y}`}
                  className={`radar-blip ${item.tone}`}
                  style={{
                    left: `${item.x}%`,
                    top: `${item.y}%`,
                    animationDelay: `${item.delay}s`,
                  }}
                />
              ))}
            </motion.div>
          </section>

          <motion.section className="login-card" variants={rise}>
            <h2>登录</h2>
            <p>验证码打印在宿主终端，5 分钟内有效</p>
            <Form
              layout="vertical"
              onFinish={submit}
              initialValues={{ remember: true }}
              requiredMark={false}
            >
              <Form.Item name="code" rules={[{ required: true, message: "请输入验证码" }]}>
                <Input
                  prefix={<KeyOutlined />}
                  placeholder="验证码"
                  maxLength={16}
                  autoComplete="one-time-code"
                  size="large"
                  className="code-input"
                  autoFocus
                />
              </Form.Item>
              <Form.Item name="remember" valuePropName="checked">
                <Checkbox>{days} 天内免登录</Checkbox>
              </Form.Item>
              {(failure || error) && (
                <motion.div
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: [0, -6, 6, -3, 0] }}
                  transition={{ duration: 0.4 }}
                >
                  <Typography.Text className="login-error" type="danger">
                    {failure || error}
                  </Typography.Text>
                </motion.div>
              )}
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                loading={submitting}
                className="login-submit"
              >
                进入控制台 <ArrowRightOutlined />
              </Button>
              <Button
                type="text"
                size="large"
                block
                onClick={generate}
                loading={requesting}
                className="request-code"
              >
                获取验证码
              </Button>
            </Form>
          </motion.section>
        </motion.main>
      </div>
    </ConfigProvider>
  )
}
