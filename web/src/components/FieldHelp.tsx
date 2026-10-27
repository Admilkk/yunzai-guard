import { useEffect, useRef, useState, type ReactNode } from "react"
import { Button, Popover } from "antd"
import { QuestionCircleOutlined } from "@ant-design/icons"
import { settingHelp, type SettingHelp } from "../lib/help"

/** 字段说明图标，悬停或点击查看。 */
export function FieldHelp({ label, help }: { label: string; help: SettingHelp }) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  useEffect(() => {
    if (!open) return
    const close = () => {
      pinned.current = false
      setOpen(false)
    }
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (
        target instanceof Node &&
        !trigger.current?.contains(target) &&
        !content.current?.contains(target)
      )
        close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("pointerdown", outside, true)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", outside, true)
      document.removeEventListener("keydown", escape)
    }
  }, [open])
  return (
    <Popover
      open={open}
      onOpenChange={next => {
        if (!pinned.current) setOpen(next)
      }}
      trigger={["hover", "focus"]}
      placement="topLeft"
      content={
        <div ref={content} className="field-help-content">
          <div className="field-help-title">{label}</div>
          <div>{help.description}</div>
          {help.default && (
            <div className="field-help-detail">
              <b>默认</b>
              {help.default}
            </div>
          )}
          {help.change && (
            <div className="field-help-detail">
              <b>生效</b>
              {help.change}
            </div>
          )}
        </div>
      }
    >
      <Button
        ref={trigger}
        type="text"
        htmlType="button"
        size="small"
        className="field-help-trigger"
        aria-label={`${label}说明`}
        aria-expanded={open}
        icon={<QuestionCircleOutlined aria-hidden />}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          pinned.current = true
          setOpen(true)
        }}
      />
    </Popover>
  )
}

/** 带说明图标的字段标签。 */
export function FieldLabel({
  children,
  helpKey,
  help,
}: {
  children: ReactNode
  helpKey?: string
  help?: SettingHelp
}) {
  const info = help ?? (helpKey ? settingHelp[helpKey] : undefined)
  const label = typeof children === "string" ? children : "配置项"
  return (
    <span className="field-label">
      <span>{children}</span>
      {info && <FieldHelp label={label} help={info} />}
    </span>
  )
}
