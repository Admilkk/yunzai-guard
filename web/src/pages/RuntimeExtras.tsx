import { useState } from "react"
import { App, Button, Card } from "antd"
import { api } from "../api"
import { ConfigField } from "../lib/fields"
import { useConsole } from "../state"

const actionOptions = [
  { value: "deny", label: "拦截" },
  { value: "restart", label: "重启" },
  { value: "audit", label: "仅记录" },
]
const kindOptions = [
  { value: "network", label: "网络访问" },
  { value: "listen", label: "端口监听" },
  { value: "process", label: "启动进程" },
  { value: "native", label: "原生扩展" },
  { value: "filesystem", label: "文件写入" },
]
const categories: Array<[string, string]> = [
  ["deny", "拦截"],
  ["restart", "触发重启"],
  ["tripped", "业务熔断"],
  ["integrity", "函数被改动"],
  ["anomaly", "画像异常"],
  ["source", "插件来源变化"],
  ["update", "版本更新"],
]

/** 告警通知：渠道、类别、Webhook 与限流。 */
export function AlertSettings() {
  const { message } = App.useApp()
  const { dirty } = useConsole()
  const [testing, setTesting] = useState(false)

  /** 用已保存的 Webhook 地址发一条测试消息。 */
  async function testWebhook() {
    setTesting(true)
    try {
      const result = await api("/api/alerts/test", { method: "POST", body: "{}" })
      if (result.ok) message.success(`已发送，对方返回 ${result.status}`)
      else message.warning(result.error ?? `对方返回 ${result.status}`)
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "发送失败")
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <Card title="告警通知" className="setting-section">
        <ConfigField label="启用告警" path={["alerts", "enabled"]} type="switch" />
        <ConfigField label="通知主人" path={["alerts", "masters"]} type="switch" />
        {categories.map(([key, label]) => (
          <ConfigField key={key} label={label} path={["alerts", "on", key]} type="switch" />
        ))}
        <ConfigField
          label="限流窗口"
          path={["alerts", "throttle", "windowMs"]}
          type="number"
          min={1000}
          max={3600000}
          step={1000}
          unit="毫秒"
        />
        <ConfigField
          label="窗口内最多"
          path={["alerts", "throttle", "maxPerWindow"]}
          type="number"
          min={1}
          max={100}
          unit="条，其余合并为摘要"
        />
      </Card>
      <Card
        title="Webhook"
        className="setting-section"
        extra={
          <Button
            size="small"
            loading={testing}
            disabled={dirty}
            onClick={() => void testWebhook()}
          >
            发送测试
          </Button>
        }
      >
        <ConfigField
          label="地址"
          path={["alerts", "webhook", "url"]}
          placeholder="https://example.com/hook，留空不启用"
        />
        <ConfigField
          label="签名密钥"
          path={["alerts", "webhook", "secret"]}
          type="secret"
          placeholder="可选，用于 X-Guard-Signature"
        />
        <ConfigField
          label="格式"
          path={["alerts", "webhook", "format"]}
          type="select"
          options={[
            { value: "json", label: "JSON" },
            { value: "text", label: "纯文本" },
          ]}
        />
        <ConfigField
          label="转发事件"
          path={["alerts", "forward", "actions"]}
          type="multi"
          options={actionOptions}
          placeholder="不转发审计事件"
        />
        <ConfigField
          label="转发类型"
          path={["alerts", "forward", "kinds"]}
          type="multi"
          options={kindOptions}
          placeholder="全部类型"
        />
      </Card>
    </>
  )
}

/** 行为画像：学习期、检测项与忽略范围。 */
export function BaselineSettings() {
  return (
    <>
      <Card title="行为画像" className="setting-section">
        <ConfigField label="启用画像" path={["baseline", "enabled"]} type="switch" />
        <ConfigField
          label="学习时长"
          path={["baseline", "learnHours"]}
          type="number"
          min={1}
          max={8760}
          unit="小时"
        />
        <ConfigField
          label="覆盖类型"
          path={["baseline", "kinds"]}
          type="multi"
          options={kindOptions}
        />
        <ConfigField
          label="推送级别"
          path={["baseline", "minSeverity"]}
          type="select"
          options={[
            { value: "low", label: "低及以上" },
            { value: "medium", label: "中及以上" },
            { value: "high", label: "仅高" },
          ]}
        />
        <ConfigField label="提示后自动信任" path={["baseline", "learnAfterAlert"]} type="switch" />
        <ConfigField label="非常规时段" path={["baseline", "offHours"]} type="switch" />
        <ConfigField
          label="每个插件最多记录"
          path={["baseline", "maxPerPlugin"]}
          type="number"
          min={10}
          max={5000}
          unit="项"
        />
        <ConfigField
          label="忽略行为"
          path={["baseline", "ignore"]}
          type="list"
          placeholder="如 network:*.qq.com，回车添加"
        />
        <ConfigField
          label="忽略插件"
          path={["baseline", "ignorePlugins"]}
          type="list"
          placeholder="插件名，支持 *"
        />
      </Card>
      <Card title="频率突增与批量新目标" className="setting-section">
        <ConfigField label="检测频率突增" path={["baseline", "spike", "enabled"]} type="switch" />
        <ConfigField
          label="统计窗口"
          path={["baseline", "spike", "windowMs"]}
          type="number"
          min={60000}
          max={3600000}
          step={60000}
          unit="毫秒"
        />
        <ConfigField
          label="灵敏度"
          path={["baseline", "spike", "zScore"]}
          type="number"
          min={1}
          max={50}
          unit="倍标准差，越小越敏感"
        />
        <ConfigField
          label="最少次数"
          path={["baseline", "spike", "minCount"]}
          type="number"
          min={1}
          max={100000}
          unit="次"
        />
        <ConfigField label="检测批量新目标" path={["baseline", "burst", "enabled"]} type="switch" />
        <ConfigField
          label="新目标数量"
          path={["baseline", "burst", "count"]}
          type="number"
          min={2}
          max={1000}
          unit="个"
        />
        <ConfigField
          label="时间范围"
          path={["baseline", "burst", "windowMs"]}
          type="number"
          min={10000}
          max={86400000}
          step={60000}
          unit="毫秒"
        />
      </Card>
    </>
  )
}

/** 插件来源：Git 插件的扫描间隔与通知范围。 */
export function SourceSettings() {
  return (
    <Card title="插件来源校验" className="setting-section">
      <ConfigField label="启用" path={["sources", "enabled"]} type="switch" />
      <ConfigField
        label="扫描间隔"
        path={["sources", "intervalMs"]}
        type="number"
        min={60000}
        max={86400000}
        step={60000}
        unit="毫秒"
      />
      <ConfigField label="文件被改动时通知" path={["sources", "notify", "dirty"]} type="switch" />
      <ConfigField
        label="远端地址变化时通知"
        path={["sources", "notify", "remote"]}
        type="switch"
      />
      <ConfigField label="提交变化时通知" path={["sources", "notify", "commit"]} type="switch" />
      <ConfigField
        label="忽略插件"
        path={["sources", "ignore"]}
        type="list"
        placeholder="插件目录名，支持 *"
      />
    </Card>
  )
}
