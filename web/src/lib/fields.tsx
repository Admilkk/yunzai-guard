import { Form, Input, InputNumber, Select, Switch } from "antd"
import { useConsole } from "../state"
import type { Draft } from "../types"
import { FieldLabel } from "../components/FieldHelp"
import { helpForPath } from "./help"
import { functionName } from "./labels"

export const actionOptions = [
  { value: "audit", label: "记录" },
  { value: "deny", label: "拒绝" },
  { value: "restart", label: "重启" },
]
export const violationOptions = actionOptions.filter(item => item.value !== "audit")
export const fileOptions = [
  { value: "off", label: "不记录" },
  { value: "write", label: "仅修改" },
  { value: "all", label: "读写全部" },
]
export const networkOptions = [
  { value: "none", label: "禁止网络" },
  { value: "host", label: "允许网络" },
]
/** 把多行文本拆为去重的非空列表。 */
export const listValue = (value: string) =>
  value
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
/** 按路径读取值。 */
export function readPath(source: any, path: string[]) {
  return path.reduce((value, key) => value?.[key], source)
}
/** 按路径写入值，必要时创建中间对象。 */
export function writePath(source: Draft, path: string[], value: any) {
  let cursor: any = source
  for (const key of path.slice(0, -1)) cursor = cursor[key] ??= {}
  if (value === undefined) delete cursor[path[path.length - 1]]
  else cursor[path[path.length - 1]] = value
}
interface FieldProps {
  label: string
  path: string[]
  type?: "text" | "secret" | "list" | "multi" | "number" | "switch" | "select"
  options?: Array<{ value: string; label: string }>
  min?: number
  max?: number
  step?: number
  fallback?: any
  unit?: string
  disabled?: boolean
  placeholder?: string
}
/** 绑定配置路径的表单字段。 */
export function ConfigField({
  label,
  path,
  type = "text",
  options,
  min,
  max,
  step,
  fallback,
  unit,
  disabled = false,
  placeholder,
}: FieldProps) {
  const { draft, overview, update, saving } = useConsole()
  const value = readPath(draft, path) ?? fallback
  const change = (next: any) => update(document => writePath(document, path, next))
  const id = `field-${path.join("-")}`
  const locked = saving || disabled
  let control
  if (type === "switch")
    control = <Switch id={id} checked={Boolean(value)} disabled={locked} onChange={change} />
  else if (type === "select")
    control = (
      <Select
        id={id}
        className="setting-input"
        value={value}
        options={options}
        disabled={locked}
        onChange={change}
      />
    )
  else if (type === "number")
    control = (
      <InputNumber
        id={id}
        value={value}
        min={min}
        max={max}
        step={step}
        precision={0}
        disabled={locked}
        className="setting-input setting-number"
        placeholder={placeholder}
        onChange={next => change(next ?? undefined)}
      />
    )
  else if (type === "multi")
    control = (
      <Select
        id={id}
        mode="multiple"
        className="setting-input setting-list"
        value={value ?? []}
        options={options}
        disabled={locked}
        placeholder={placeholder}
        onChange={change}
      />
    )
  else if (type === "secret")
    control = (
      <Input.Password
        id={id}
        value={value ?? ""}
        disabled={locked}
        className="setting-input setting-path"
        placeholder={placeholder}
        autoComplete="new-password"
        onChange={event => change(event.target.value || undefined)}
      />
    )
  else if (type === "list")
    control = (
      <Select
        id={id}
        mode="tags"
        maxTagCount="responsive"
        options={
          path.join(".") === "protect.targets"
            ? [
                ...new Set([
                  ...(Array.isArray(value) ? value : []),
                  ...(overview?.defaults?.protectTargets ?? []),
                ]),
              ].map(value => ({ value, label: functionName(value), title: value }))
            : undefined
        }
        filterOption={(input, option) =>
          String(option?.label ?? option?.value ?? "")
            .toLowerCase()
            .includes(input.toLowerCase()) ||
          String(option?.value ?? "")
            .toLowerCase()
            .includes(input.toLowerCase())
        }
        value={value ?? []}
        disabled={locked}
        className="setting-input setting-list"
        placeholder={placeholder}
        onChange={change}
        tokenSeparators={["\n"]}
      />
    )
  else
    control = (
      <Input
        id={id}
        value={value ?? ""}
        disabled={locked}
        className="setting-input setting-path"
        placeholder={placeholder}
        onChange={event => change(event.target.value || undefined)}
      />
    )
  return (
    <Form.Item
      className={`setting-row setting-row-${type}`}
      label={<FieldLabel help={helpForPath(path)}>{label}</FieldLabel>}
      htmlFor={id}
    >
      <div className="setting-control">
        {control}
        {unit && <span className="setting-unit">{unit}</span>}
      </div>
    </Form.Item>
  )
}
