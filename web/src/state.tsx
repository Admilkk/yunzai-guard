import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { App as AntApp } from "antd"
import { api, ApiError, setCsrf } from "./api"
import { mergedDocument } from "./lib/config"
import { documentChanges, parseRaw } from "./lib/diff"
import type { ConsoleValue, Draft, PluginRecord, SettingsApplyState } from "./types"

/**
 * 聊天登录链接的令牌放在地址片段 `#login=` 里：模块加载时取出并立即从地址栏抹掉，
 * 只尝试一次，避免留在浏览历史或被开发模式的重复执行再次提交。
 */
let linkToken = (() => {
  const match = /^#login=([A-Za-z0-9_-]{43})$/.exec(location.hash)
  if (match) history.replaceState(null, "", location.pathname + location.search)
  return match?.[1]
})()

const Context = createContext<ConsoleValue | null>(null)

/** 确认配置中的数字均为整数。 */
function assertIntegers(value: unknown, path = "settings", depth = 0): void {
  if (depth > 80) throw new Error("配置嵌套层级超出限制")
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error(`${path} 必须为安全整数`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertIntegers(item, `${path}[${index}]`, depth + 1))
    return
  }
  if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      assertIntegers(item, `${path}.${key}`, depth + 1)
}

/** 提供控制台全局状态：配置草稿、保存与刷新。 */
export function ConsoleProvider({ children }: { children: ReactNode }) {
  const { message, modal } = AntApp.useApp()
  const [booting, setBooting] = useState(true)
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState("")
  const [meta, setMeta] = useState<Record<string, any> | null>(null)
  const [session, setSession] = useState<Record<string, any> | null>(null)
  const [overview, setOverview] = useState<Record<string, any> | null>(null)
  const [plugins, setPlugins] = useState<PluginRecord[]>([])
  const [settings, setSettings] = useState<Record<string, any> | null>(null)
  const [configurationLoaded, setConfigurationLoaded] = useState(false)
  const [configurationError, setConfigurationError] = useState<string | null>(null)
  const [apply, setApply] = useState<SettingsApplyState>()
  const [draft, setDraft] = useState<Draft>({})
  const [serverDoc, setServerDoc] = useState<Draft>({})
  const [rawText, setRawText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const loadSequence = useRef(0)
  const changes = useMemo(
    () => (settings ? documentChanges(serverDoc, draft, rawText) : []),
    [draft, rawText, serverDoc, settings],
  )
  // 只改了注释时配置对象不变，但原文变了，同样需要保存。
  const dirty = changes.length > 0 || (rawText !== null && rawText !== settings?.text)
  const current = useRef({ draft, serverDoc, rawText, dirty, settings })
  current.current = { draft, serverDoc, rawText, dirty, settings }

  const reload = useCallback(
    async (preserve = true) => {
      const sequence = ++loadSequence.current
      setLoading(true)
      try {
        const [nextOverview, nextSettings, nextPlugins] = await Promise.all([
          api("/api/overview"),
          api("/api/settings"),
          api("/api/plugins"),
        ])
        if (sequence !== loadSequence.current) return
        setOverview(nextOverview)
        setPlugins(nextPlugins.plugins ?? [])
        setApply(nextOverview.apply ?? nextSettings.apply)
        setConfigurationLoaded(true)
        setConfigurationError(
          nextSettings.valid === false ? (nextSettings.error ?? "配置无效") : null,
        )
        if (!preserve || !current.current.dirty) {
          const next =
            nextSettings.normalized ?? mergedDocument(nextSettings.document, nextOverview.active)
          const nextRaw = nextSettings.valid === false ? nextSettings.text : null
          const nextServer = structuredClone(next)
          setSettings(nextSettings)
          setDraft(next)
          setServerDoc(nextServer)
          setRawText(nextRaw)
          current.current = {
            draft: next,
            serverDoc: nextServer,
            rawText: nextRaw,
            dirty: nextSettings.valid === false,
            settings: nextSettings,
          }
          if (nextSettings.valid === false) message.error(nextSettings.error ?? "配置无效")
        }
        setConnected(true)
        setError("")
      } catch (failure) {
        if (sequence !== loadSequence.current) return
        setConnected(false)
        setError((failure as Error).message)
        throw failure
      } finally {
        if (sequence === loadSequence.current) setLoading(false)
      }
    },
    [message],
  )

  const clearSession = useCallback(() => {
    setSession(null)
    setConnected(false)
    setConfigurationLoaded(false)
    setApply(undefined)
    setCsrf("")
  }, [])

  useEffect(() => {
    if (!session || apply?.status !== "applying") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        await reload(true)
      } catch {}
      if (!cancelled) timer = setTimeout(poll, 1000)
    }
    timer = setTimeout(poll, 700)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [session, apply?.status, reload])
  /** 建立登录会话，重新认证时保留尚未保存的配置草稿。 */
  const enter = useCallback(async () => {
    const value = await api("/api/session")
    setCsrf(value.csrfToken)
    setSession(value)
    await reload(true)
  }, [reload])

  useEffect(() => {
    let live = true
    const onExpired = () => {
      if (live) clearSession()
    }
    window.addEventListener("guard:unauthorized", onExpired)
    void (async () => {
      try {
        localStorage.removeItem("yunzai-guard-panel-token")
        const value = await api("/api/meta")
        if (!live) return
        setMeta(value)
        const link = linkToken
        linkToken = undefined
        if (link) {
          try {
            await api("/api/login/link", { method: "POST", body: JSON.stringify({ token: link }) })
          } catch (failure) {
            if (live) setError((failure as Error).message)
            return
          }
        }
        await enter()
      } catch (failure) {
        // 首次打开尚未登录属于正常情况，不提示“登录已失效”。
        const unauthorized = failure instanceof ApiError && failure.status === 401
        if (live && !unauthorized) setError((failure as Error).message)
      } finally {
        if (live) setBooting(false)
      }
    })()
    return () => {
      live = false
      window.removeEventListener("guard:unauthorized", onExpired)
    }
  }, [clearSession, enter])

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current.dirty || savingRef.current) {
        event.preventDefault()
        event.returnValue = ""
      }
    }
    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [])

  const candidate = (): Draft =>
    current.current.rawText === null ? current.current.draft : parseRaw(current.current.rawText)

  const update = (change: (value: Draft) => void): boolean => {
    if (savingRef.current) return false
    try {
      const next = structuredClone(candidate())
      change(next)
      const dirty = documentChanges(current.current.serverDoc, next, null).length > 0
      current.current = { ...current.current, draft: next, rawText: null, dirty }
      setDraft(next)
      setRawText(null)
      return true
    } catch (failure) {
      message.error((failure as Error).message)
      return false
    }
  }

  // 原始配置按原文保存才能保留注释，因此离开前须先保存或撤销，不再并入表单草稿。
  const commitRaw = () => {
    if (savingRef.current) return false
    if (current.current.rawText === null) return true
    if (!current.current.dirty) {
      current.current = { ...current.current, rawText: null }
      setRawText(null)
      return true
    }
    message.warning("原始配置有未保存的修改，请先保存或撤销")
    return false
  }

  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const value = candidate()
      assertIntegers(value)
      const raw = current.current.rawText
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...(raw === null ? { document: value } : { raw }),
          revision: current.current.settings?.revision,
        }),
      })
      setApply(result.apply)
      await reload(false)
      if (result.apply?.status === "failed") message.error("应用失败")
      else message.success("已保存")
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409)
        modal.confirm({
          title: "配置已在其他页面更新",
          content: "载入最新配置会替换当前草稿。",
          okText: "载入最新",
          cancelText: "保留草稿",
          onOk: () => reload(false),
        })
      else message.error((failure as Error).message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const validate = async () => {
    if (savingRef.current) return
    try {
      const value = candidate()
      assertIntegers(value)
      const raw = current.current.rawText
      const result = await api("/api/settings/validate", {
        method: "POST",
        body: JSON.stringify(raw === null ? { document: value } : { raw }),
      })
      if (!result.ok) throw new Error(result.error)
      message.success("校验通过")
    } catch (failure) {
      message.error((failure as Error).message)
    }
  }

  const value: ConsoleValue = {
    booting,
    loading,
    connected,
    configurationLoaded,
    configurationError,
    settingsRevision: settings?.revision,
    settingsText: settings?.text,
    error,
    meta,
    session,
    overview,
    plugins,
    draft,
    dirty,
    changes,
    saving,
    pendingRestart: Boolean(overview?.pendingRestart ?? settings?.pendingRestart),
    apply,
    rawText,
    setRawText: text => {
      if (savingRef.current) return
      const dirty =
        text === null
          ? documentChanges(current.current.serverDoc, current.current.draft, null).length > 0
          : documentChanges(current.current.serverDoc, current.current.draft, text).length > 0 ||
            text !== current.current.settings?.text
      current.current = { ...current.current, rawText: text, dirty }
      setRawText(text)
    },
    update,
    commitRaw,
    reload,
    save,
    validate,
    requestCode: async () => {
      await api("/api/login/code/request", { method: "POST", body: "{}" })
    },
    login: async (code, remember) => {
      await api("/api/login/code/check", {
        method: "POST",
        body: JSON.stringify({ code, remember }),
      })
      await enter()
    },
    logout: async () => {
      try {
        await api("/api/logout", { method: "POST", body: "{}" })
        clearSession()
      } catch (failure) {
        message.error((failure as Error).message)
      }
    },
    reset: () => {
      if (savingRef.current) return
      const next = structuredClone(current.current.serverDoc)
      current.current = { ...current.current, draft: next, rawText: null, dirty: false }
      setDraft(next)
      setRawText(null)
    },
  }
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** 读取控制台全局状态。 */
export function useConsole(): ConsoleValue {
  const value = useContext(Context)
  if (!value) throw new Error("ConsoleProvider is missing")
  return value
}
