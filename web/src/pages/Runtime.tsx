import { useRef } from "react"
import { Button, Card, Form, InputNumber, Switch, Tabs } from "antd"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useConsole } from "../state"
import { ConfigField, actionOptions, fileOptions, networkOptions } from "../lib/fields"
import { FieldLabel } from "../components/FieldHelp"
import { AlertSettings, BaselineSettings, SourceSettings } from "./RuntimeExtras"

/** 控制端口设置。 */
function ControlPort() {
  const { draft, update, saving } = useConsole()
  const port = draft.controlPort ?? 0
  const automatic = port === 0
  const manual = useRef(port || 21734)
  if (!automatic) manual.current = port
  return (
    <Form.Item
      label={<FieldLabel helpKey="controlPort">控制端口</FieldLabel>}
      className="setting-row"
    >
      <div className="setting-control setting-port">
        <Switch
          aria-label="自动分配控制端口"
          checked={automatic}
          disabled={saving}
          onChange={value =>
            update(document => {
              if (value) delete document.controlPort
              else document.controlPort = manual.current
            })
          }
        />
        <span className="setting-option-label">自动分配</span>
        <InputNumber
          aria-label="手动控制端口"
          className="setting-input setting-number"
          min={1024}
          max={65535}
          precision={0}
          value={automatic ? undefined : port}
          placeholder="1024–65535"
          disabled={saving || automatic}
          onChange={value => {
            if (value === null) return
            manual.current = value
            update(document => {
              document.controlPort = value
            })
          }}
        />
      </div>
    </Form.Item>
  )
}

/** 业务监控设置。 */
function Monitoring() {
  const { overview, update, saving } = useConsole()
  const defaults = overview?.defaults?.protectTargets
  return (
    <Card
      title="业务监控"
      className="setting-section"
      extra={
        <Button
          size="small"
          disabled={saving || !Array.isArray(defaults)}
          onClick={() =>
            update(document => {
              ;(document.protect ??= {}).targets = [...defaults]
            })
          }
        >
          恢复默认函数
        </Button>
      }
    >
      <ConfigField
        label="文件访问记录"
        path={["monitor", "files"]}
        type="select"
        options={fileOptions}
      />
      <ConfigField label="系统层观察" path={["monitor", "process"]} type="switch" />
      <ConfigField label="函数变化监控" path={["protect", "enabled"]} type="switch" />
      <ConfigField
        label="监控入口保护"
        path={["protect", "monitorInstrumentation"]}
        type="switch"
      />
      <ConfigField
        label="检查间隔"
        path={["protect", "intervalMs"]}
        type="number"
        min={10}
        max={60000}
        step={50}
        unit="毫秒"
      />
      <ConfigField
        label="默认处理"
        path={["protect", "action"]}
        type="select"
        options={actionOptions}
      />
      <ConfigField
        label="监控函数"
        path={["protect", "targets"]}
        type="list"
        placeholder="Bot.em"
      />
    </Card>
  )
}

/** 故障恢复设置。 */
function Recovery() {
  return (
    <div className="page-stack">
      <Card title="进程恢复" className="setting-section">
        <ConfigField
          label="重启上限"
          path={["recovery", "maxRestarts"]}
          type="number"
          min={0}
          max={100}
          unit="次"
        />
        <ConfigField
          label="统计窗口"
          path={["recovery", "windowMs"]}
          type="number"
          min={1000}
          max={86400000}
          step={1000}
          unit="毫秒"
        />
        <ConfigField
          label="基础退避"
          path={["recovery", "baseDelayMs"]}
          type="number"
          min={0}
          max={60000}
          step={50}
          unit="毫秒"
        />
        <ConfigField
          label="最大退避"
          path={["recovery", "maxDelayMs"]}
          type="number"
          min={0}
          max={300000}
          step={500}
          unit="毫秒"
        />
      </Card>
      <Card title="启动与退出" className="setting-section">
        <ControlPort />
        <ConfigField
          label="启动超时"
          path={["startupTimeout"]}
          type="number"
          min={100}
          max={300000}
          step={1000}
          unit="毫秒"
        />
        <ConfigField
          label="关闭超时"
          path={["shutdownTimeout"]}
          type="number"
          min={10}
          max={120000}
          step={500}
          unit="毫秒"
        />
        <ConfigField
          label="交接超时"
          path={["handshakeTimeout"]}
          type="number"
          min={100}
          max={120000}
          step={500}
          unit="毫秒"
        />
      </Card>
    </div>
  )
}

/** 审计存储设置。 */
function AuditStorage() {
  return (
    <Card title="审计存储" className="setting-section">
      <ConfigField
        label="事件速率上限"
        path={["audit", "maxEventsPerSecond"]}
        type="number"
        min={1}
        max={10000}
        unit="条/秒"
      />
      <ConfigField
        label="缓冲队列上限"
        path={["audit", "maxQueue"]}
        type="number"
        min={1}
        max={100000}
        unit="条"
      />
      <ConfigField
        label="基础保留容量"
        path={["audit", "maxBytes"]}
        type="number"
        min={1024}
        max={1073741824}
        step={1024}
        unit="字节"
      />
      <ConfigField
        label="保留倍数"
        path={["audit", "maxFiles"]}
        type="number"
        min={1}
        max={100}
        unit="倍"
      />
      <ConfigField
        label="相同事件合并"
        path={["audit", "coalesceMs"]}
        type="number"
        min={0}
        max={60000}
        step={100}
        unit="毫秒（0 为逐条）"
      />
      <ConfigField
        label="写盘策略"
        path={["audit", "durability"]}
        type="select"
        options={[
          { value: "adaptive", label: "自适应（拦截记录强制落盘）" },
          { value: "full", label: "每批强制落盘" },
        ]}
      />
      <ConfigField
        label="按天数保留"
        path={["audit", "maxDays"]}
        type="number"
        min={0}
        max={3650}
        unit="天（0 为不限）"
      />
    </Card>
  )
}

/** 宿主日志清理设置。 */
function HostLog() {
  return (
    <Card title="宿主日志" className="setting-section">
      <ConfigField
        label="单文件上限"
        path={["log", "maxBytes"]}
        type="number"
        min={65536}
        max={1073741824}
        step={65536}
        unit="字节"
      />
      <ConfigField
        label="按天数保留"
        path={["log", "maxDays"]}
        type="number"
        min={0}
        max={3650}
        unit="天（0 为不限）"
      />
    </Card>
  )
}

/** 运行隔离设置。 */
function Isolation() {
  const { draft } = useConsole()
  const reduced = useReducedMotion()
  const sandboxed = draft.isolationMode === "os-sandbox"
  return (
    <Card title="运行隔离" className="setting-section">
      <ConfigField
        label="运行模式"
        path={["isolationMode"]}
        type="select"
        options={[
          { value: "managed", label: "兼容托管" },
          { value: "os-sandbox", label: "系统沙箱" },
        ]}
      />
      <AnimatePresence initial={false}>
        {sandboxed && (
          <motion.div
            key="os-sandbox"
            className="isolation-fields"
            initial={reduced ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduced ? 0 : 0.17 }}
          >
            <ConfigField
              label="沙箱网络"
              path={["sandbox", "network"]}
              type="select"
              options={networkOptions}
            />
            <ConfigField label="可写目录" path={["sandbox", "writablePaths"]} type="list" />
            <ConfigField
              label="bubblewrap 路径"
              path={["sandbox", "bwrapPath"]}
              placeholder="自动检测"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

/** 版本检查与更新通知。 */
function Updates() {
  return (
    <Card title="版本更新" className="setting-section">
      <ConfigField label="自动检查" path={["update", "check"]} type="switch" />
      <ConfigField label="通知主人" path={["update", "notify"]} type="switch" />
      <ConfigField
        label="检查间隔"
        path={["update", "intervalMs"]}
        type="number"
        min={60000}
        max={86400000}
        step={60000}
        unit="毫秒"
      />
    </Card>
  )
}

/** 运行设置页面。 */
export default function Runtime() {
  return (
    <Form layout="horizontal" labelCol={{ flex: "132px" }} className="settings-form">
      <Tabs
        className="settings-tabs"
        items={[
          { key: "monitoring", label: "业务监控", children: <Monitoring /> },
          { key: "update", label: "版本更新", children: <Updates /> },
          { key: "alerts", label: "告警通知", children: <AlertSettings /> },
          { key: "baseline", label: "行为画像", children: <BaselineSettings /> },
          { key: "sources", label: "插件来源", children: <SourceSettings /> },
          { key: "recovery", label: "进程恢复", children: <Recovery /> },
          {
            key: "audit",
            label: "日志与存储",
            children: (
              <>
                <AuditStorage />
                <HostLog />
              </>
            ),
          },
          { key: "isolation", label: "运行隔离", children: <Isolation /> },
        ]}
      />
    </Form>
  )
}
