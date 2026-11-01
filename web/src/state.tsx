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
import { SaveReview } from "./components/SaveReview"
import { draftConflicts, mergeRawRules, resetConflictingRules } from "./lib/draft-actions"
import type {
  ConsoleValue,
  Draft,
  PluginRecord,
  SavedOperation,
  SettingsApplyState,
  SettingsPlan,
} from "./types"

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
  const [operations, setOperations] = useState<SavedOperation[]>([])
  const [historyError, setHistoryError] = useState("")
  const lastOperation = operations[0]
  const notifySave = (type: "info" | "warning" | "error" | "success", content: string) =>
    message.open({ key: "guard-settings-result", type, content })
  const savingRef = useRef(false)
  const saveNoticeRevision = useRef<string | undefined>(undefined)
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
        const [nextOverview, nextSettings, nextPlugins, history] = await Promise.all([
          api("/api/overview"),
          api("/api/settings"),
          api("/api/plugins"),
          api("/api/settings/operations").catch(error => ({ error: error.message })),
        ])
        if (sequence !== loadSequence.current) return
        setOverview(nextOverview)
        setPlugins(nextPlugins.plugins ?? [])
        setHistoryError(history.error ?? "")
        if (!history.error) setOperations(history.operations ?? [])
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
    setOperations([])
    setHistoryError("")
    saveNoticeRevision.current = undefined
    setCsrf("")
  }, [])

  useEffect(() => {
    if (
      saving ||
      !connected ||
      !apply ||
      apply.status === "applying" ||
      !saveNoticeRevision.current ||
      saveNoticeRevision.current !== settings?.revision
    )
      return
    saveNoticeRevision.current = undefined
    const type =
      apply.status === "failed"
        ? "error"
        : apply.status === "pending-restart"
          ? "warning"
          : "success"
    const content =
      apply.status === "failed"
        ? "已保存，应用失败"
        : apply.status === "pending-restart"
          ? "已保存，待宿主重启"
          : "已生效"
    message.open({ key: "guard-settings-result", type, content })
  }, [saving, connected, apply, settings?.revision, message])

  useEffect(() => {
    if (!session || saving || apply?.status !== "applying") return
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
  }, [session, saving, apply?.status, reload])
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
    message.warning("原始配置未保存，请先保存或撤销")
    return false
  }

  /** 同一条保存链路负责预览、版本校验、应用状态与单次撤销。快捷操作不读取草稿。 */
  const submit = async (
    title: string,
    summary: string,
    value: Draft,
    raw: string | null,
    confirm: boolean,
  ): Promise<false | { revision: string }> => {
    if (savingRef.current) return false
    const previous = current.current
    savingRef.current = true
    setSaving(true)
    // 丢弃提交前已经发出的后台读取，避免旧响应覆盖新配置。
    ++loadSequence.current
    setLoading(false)
    try {
      assertIntegers(value)
      const changes = documentChanges(previous.serverDoc, value, null)
      if (
        apply?.status !== "failed" &&
        !changes.length &&
        (raw === null || raw === previous.settings?.text)
      ) {
        message.info("无更改")
        return false
      }
      const body = raw === null ? { document: value } : { raw }
      const preview = await api<{
        ok: boolean
        error?: string
        plan: SettingsPlan
        planRevision: string
      }>("/api/settings/validate", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!preview.ok) throw new Error(preview.error ?? "配置校验失败")
      if (confirm || preview.plan.reloadFields.length || preview.plan.restartFields.length) {
        const accepted = await new Promise<boolean>(resolve => {
          modal.confirm({
            title,
            width: 580,
            content: <SaveReview summary={summary} plan={preview.plan} changes={changes} />,
            okText: preview.plan.reloadFields.length ? "保存并重启业务" : "保存",
            cancelText: "取消",
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          })
        })
        if (!accepted) return false
      }
      const result = await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...body,
          revision: previous.settings?.revision,
          planRevision: preview.planRevision,
          title,
        }),
      })
      setApply(result.apply)
      saveNoticeRevision.current = result.revision
      try {
        await reload(false)
      } catch {
        notifySave("warning", "已保存，状态读取失败")
        return { revision: result.revision }
      }
      if (result.apply?.status === "failed") notifySave("error", "已保存，应用失败")
      else if (result.apply?.status === "applying") notifySave("info", "正在应用")
      else if (result.apply?.status === "pending-restart")
        notifySave("warning", "已保存，待宿主重启")
      else notifySave("success", result.apply ? "已生效" : "已保存，生效未确认")
      if (result.historyError) {
        setHistoryError(result.historyError)
        notifySave("warning", result.historyError)
      }
      return { revision: result.revision }
    } catch (failure) {
      if (
        failure instanceof ApiError &&
        failure.status === 409 &&
        failure.message === "生效方式已变更，请重新确认"
      ) {
        message.warning(failure.message)
        await reload(true).catch(() => {})
      } else if (failure instanceof ApiError && failure.status === 409)
        modal.confirm({
          title: "配置已变更",
          content: "载入最新配置会丢弃当前草稿。",
          okText: "载入最新",
          cancelText: "保留草稿",
          onOk: () => reload(false),
        })
      else message.error((failure as Error).message)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const save = async () => {
    try {
      await submit(
        "保存配置",
        "保存全部更改，自动备份。",
        candidate(),
        current.current.rawText,
        false,
      )
    } catch (failure) {
      message.error((failure as Error).message)
    }
  }

  const quickChange: ConsoleValue["quickChange"] = async (
    title,
    summary,
    change,
    mode = "apply",
  ) => {
    if (savingRef.current) return false
    if (!connected || !configurationLoaded || configurationError) {
      message.warning("连接或配置未就绪")
      return false
    }
    try {
      const staging = mode === "draft" || current.current.dirty
      const before = staging
        ? structuredClone(candidate())
        : structuredClone(current.current.serverDoc)
      const captured = JSON.stringify(before)
      const baseRevision = current.current.settings?.revision
      const raw = current.current.rawText
      let next = structuredClone(before)
      change(next)
      if (staging) {
        const conflicts = draftConflicts(current.current.serverDoc, before, next)
        if (conflicts.length) {
          const accepted = await new Promise<boolean>(resolve =>
            modal.confirm({
              title: "草稿规则冲突",
              content: (
                <>
                  <p>以下草稿规则将被替换：</p>
                  <ul>
                    {conflicts.map(rule => (
                      <li key={rule.id}>{rule.id}</li>
                    ))}
                  </ul>
                </>
              ),
              okText: "使用本次操作",
              cancelText: "保留草稿",
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            }),
          )
          if (!accepted) return false
          if (
            savingRef.current ||
            baseRevision !== current.current.settings?.revision ||
            raw !== current.current.rawText ||
            captured !== JSON.stringify(candidate())
          )
            throw new Error("草稿已变更，请重试")
          next = resetConflictingRules(current.current.serverDoc, before, conflicts)
          change(next)
        }
        const nextRaw = raw === null ? null : mergeRawRules(raw, next.rules ?? [])
        const dirty =
          documentChanges(current.current.serverDoc, next, nextRaw).length > 0 ||
          (nextRaw !== null && nextRaw !== current.current.settings?.text)
        current.current = { ...current.current, draft: next, rawText: nextRaw, dirty }
        setDraft(next)
        setRawText(nextRaw)
        message.success("已加入草稿")
        return { staged: true }
      }
      const result = await submit(
        title,
        `${summary}\n仅调整监控规则，沙箱限制仍生效。`,
        next,
        null,
        true,
      )
      return result ? { staged: false, revision: result.revision } : false
    } catch (failure) {
      message.error((failure as Error).message)
      return false
    }
  }

  const canUndo = Boolean(
    lastOperation && lastOperation.canUndo && !dirty && !saving && connected && !configurationError,
  )
  const restoreOperation: ConsoleValue["restoreOperation"] = async (id, target = "before") => {
    if (savingRef.current) return false
    if (current.current.dirty) {
      message.warning("先保存或放弃草稿")
      return false
    }
    if (!connected) {
      message.warning("宿主未连接")
      return false
    }
    savingRef.current = true
    setSaving(true)
    ++loadSequence.current
    setLoading(false)
    try {
      const preview = await api<{
        operation: SavedOperation
        revision: string
        previewToken: string
        changes: SavedOperation["changes"]
        plan: SettingsPlan
        hasLaterChanges: boolean
      }>("/api/settings/operations/preview", {
        method: "POST",
        body: JSON.stringify({ id, target, revision: current.current.settings?.revision }),
      })
      const accepted = await new Promise<boolean>(resolve =>
        modal.confirm({
          title: target === "before" ? "撤销修改" : "恢复配置",
          width: 620,
          content: (
            <SaveReview
              summary={`${preview.operation.title}\n${target === "before" ? "恢复修改前的配置及注释" : "恢复该次应用成功的配置"}${preview.hasLaterChanges ? "\n包含后续修改，请核对差异" : ""}`}
              plan={preview.plan}
              changes={preview.changes}
              expanded={preview.hasLaterChanges}
            />
          ),
          okText: preview.plan.reloadFields.length ? "恢复并重启业务" : "恢复",
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      )
      if (!accepted) return false
      const result = await api("/api/settings/operations/restore", {
        method: "POST",
        body: JSON.stringify({
          id,
          target,
          revision: preview.revision,
          previewToken: preview.previewToken,
        }),
      })
      setApply(result.apply)
      saveNoticeRevision.current = result.revision
      try {
        await reload(false)
      } catch {
        notifySave("warning", "已恢复，状态读取失败")
        return true
      }
      notifySave("info", "已恢复，正在应用")
      if (result.historyError) {
        setHistoryError(result.historyError)
        notifySave("warning", result.historyError)
      }
      return true
    } catch (error) {
      message.error((error as Error).message)
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const undoLast = async () => {
    if (!lastOperation || !canUndo) {
      message.warning("无法撤销，请检查草稿和配置版本")
      return
    }
    await restoreOperation(lastOperation.id)
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
    lastOperation,
    operations,
    historyError,
    canUndo,
    quickChange,
    undoLast,
    restoreOperation,
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
