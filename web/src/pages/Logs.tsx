import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { App, Button, Card, Checkbox, Input, Space, Tag } from "antd"
import { ClearOutlined, PauseOutlined, CaretRightOutlined, SearchOutlined } from "@ant-design/icons"
import { api } from "../api"

const colors = [
  "#7a8496",
  "#ff777c",
  "#67d7a2",
  "#e8c67a",
  "#83acff",
  "#c99df3",
  "#70d5df",
  "#dbe3ef",
]
/** 把 ANSI 颜色转义转为带样式的节点。 */
function ansi(text: string): ReactNode[] {
  const result: ReactNode[] = []
  const expression = /\x1b\[([0-9;]*)m/g
  let at = 0
  let match: RegExpExecArray | null
  let style: CSSProperties = {}
  while ((match = expression.exec(text))) {
    if (match.index > at)
      result.push(
        <span key={at} style={style}>
          {text.slice(at, match.index).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}
        </span>,
      )
    style = { ...style }
    for (const code of (match[1] || "0").split(";").map(Number)) {
      if (code === 0) style = {}
      else if (code === 1) style.fontWeight = 600
      else if (code === 22) delete style.fontWeight
      else if (code === 39) delete style.color
      else if (code >= 30 && code <= 37) style.color = colors[code - 30]
      else if (code >= 90 && code <= 97) style.color = colors[code - 90]
    }
    at = expression.lastIndex
  }
  result.push(
    <span key={`last-${at}`} style={style}>
      {text.slice(at).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")}
    </span>,
  )
  return result
}

/** 实时日志页面。 */
export default function Logs() {
  const { message } = App.useApp()
  const [text, setText] = useState("")
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("连接中")
  const buffer = useRef("")
  const pausedRef = useRef(false)
  const view = useRef<HTMLPreElement>(null)
  useEffect(() => {
    pausedRef.current = paused
    if (!paused) setText(buffer.current)
  }, [paused])
  useEffect(() => {
    let active = true
    let source: EventSource | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    const controller = new AbortController()
    const update = (value: string) => {
      buffer.current = value.slice(-256 * 1024)
      if (active && !pausedRef.current) setText(buffer.current)
    }
    const load = async () => {
      if (!active) return
      try {
        const result = await api("/api/logs", { signal: controller.signal })
        if (active) {
          update(result.text ?? "")
          setStatus("轮询")
        }
      } catch (error) {
        if (active) {
          setStatus("已断开")
          message.error((error as Error).message)
        }
      }
    }
    const poll = () => {
      if (!active) return
      if (!timer) {
        void load()
        timer = setInterval(load, 3000)
      }
    }
    if (typeof EventSource === "function") {
      source = new EventSource("/api/logs/stream")
      source.onopen = () => {
        if (active) setStatus("实时连接")
      }
      source.onmessage = event => {
        if (!active) return
        try {
          const result = JSON.parse(event.data)
          if (typeof result.text === "string") update(result.text)
          else if (typeof result.append === "string") update(buffer.current + result.append)
        } catch {
          if (active) setStatus("格式错误")
        }
      }
      source.onerror = () => {
        if (!active) return
        source?.close()
        poll()
      }
    } else poll()
    return () => {
      active = false
      controller.abort()
      if (source) source.onopen = source.onmessage = source.onerror = null
      source?.close()
      clearInterval(timer)
    }
  }, [message])
  // 日志持续写入时，过滤与着色放到低优先级渲染，避免大缓冲区阻塞输入。
  const deferredText = useDeferredValue(text)
  const deferredQuery = useDeferredValue(query)
  useEffect(() => {
    if (follow && view.current) view.current.scrollTop = view.current.scrollHeight
  }, [deferredText, follow])
  const visibleText = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase()
    if (!needle) return deferredText
    const matches = deferredText
      .split("\n")
      .filter(line => line.toLowerCase().includes(needle))
      .join("\n")
    return matches || "没有匹配的日志"
  }, [deferredText, deferredQuery])
  const content = useMemo(() => ansi(visibleText), [visibleText])
  return (
    <Card
      title="host.log"
      className="logs-card"
      extra={
        <Space wrap size={8}>
          <Input
            aria-label="搜索日志"
            className="log-search"
            prefix={<SearchOutlined />}
            placeholder="搜索日志"
            allowClear
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <Tag color={status === "实时连接" && !paused ? "green" : "orange"}>
            {paused ? "视图已暂停" : status}
          </Tag>
          <Checkbox checked={follow} onChange={event => setFollow(event.target.checked)}>
            跟随
          </Checkbox>
          <Checkbox checked={wrap} onChange={event => setWrap(event.target.checked)}>
            换行
          </Checkbox>
          <Button
            icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
            onClick={() => setPaused(value => !value)}
          >
            {paused ? "继续" : "暂停"}
          </Button>
          <Button
            icon={<ClearOutlined />}
            onClick={() => {
              buffer.current = ""
              setText("")
            }}
          >
            清屏视图
          </Button>
        </Space>
      }
    >
      <pre ref={view} className={`log-console ${wrap ? "log-wrap" : "log-nowrap"}`}>
        {content}
      </pre>
    </Card>
  )
}
