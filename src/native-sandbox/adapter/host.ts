import {
  adapterDto,
  adapterFail,
  adapterId,
  adapterKey,
  reservedAdapterIds,
  validateAdapterCall,
  validateAdapterFrame,
  validateAdapterEvent,
  type AdapterAccount,
  type AdapterEntries,
  type AdapterId,
  type AdapterMethodCall,
  type AdapterProfile,
  type AdapterRegistration,
  type AdapterSelector,
  type AdapterValue,
} from "./protocol.js"
import { M } from "../../shared/messages.js"

type Row = Record<string, unknown>
interface OwnedAccount {
  descriptor: AdapterAccount
  facade: Row
}
interface Owner {
  session: symbol
  accountHandle: string
}
const ownership = new WeakMap<object, Map<string, Owner>>()

export interface NativeAdapterHostOptions {
  pluginId: string
  bot: Row
  invoke(call: AdapterMethodCall): Promise<unknown>
  /** 可选的纯字节转换，不解析插件提供的路径或 URL。 */
  serializeArgs?(args: unknown[]): AdapterValue[]
  discardArgs?(args: AdapterValue[]): void
}

/**
 * 调用方须明确授权本会话作为可信适配器消息来源。
 * 本端自行构建全部宿主函数，不接收插件函数或 SDK。
 */
export class NativeAdapterHost {
  private readonly session = Symbol("native-adapter-session")
  private readonly owners: Map<string, Owner>
  private readonly adapters = new Map<string, { descriptor: AdapterRegistration; facade: Row }>()
  private readonly accounts = new Map<string, OwnedAccount>()
  private readonly pending = new Set<(error: Error) => void>()
  private readonly adapterArray: unknown[]
  private readonly uin: unknown[]
  private readonly emitCore: (...args: unknown[]) => unknown
  private readonly protectedIds = new Set(reservedAdapterIds)
  private closed = false

  /** 创建工作进程侧的适配器代理。 */
  constructor(private readonly options: NativeAdapterHostOptions) {
    if (
      !Array.isArray(options.bot.adapter) ||
      !Array.isArray(options.bot.uin) ||
      typeof options.bot.em !== "function"
    )
      adapterFail("ADAPTER_INVALID_HOST", "The trusted host adapter interfaces are unavailable")
    this.adapterArray = options.bot.adapter as unknown[]
    this.uin = options.bot.uin as unknown[]
    this.emitCore = options.bot.em as (...args: unknown[]) => unknown
    this.owners = ownership.get(options.bot) ?? new Map()
    ownership.set(options.bot, this.owners)
    // TRSS Bot 代理多个账号，Bot.bot 提供其可信核心实例。
    for (const root of [options.bot, options.bot.bot]) {
      if (!root || typeof root !== "object") continue
      let current: object | null = root
      for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current))
        for (const key of Reflect.ownKeys(current))
          if (typeof key === "string") this.protectedIds.add(key)
    }
  }
  /** 确认代理未被释放。 */
  private active(): void {
    if (this.closed) adapterFail("ADAPTER_CLOSED", "Host adapter capabilities are revoked")
  }

  /** 向沙箱发起适配器方法调用。 */
  private async call(
    methodHandle: string,
    args: unknown[],
    selector?: AdapterSelector,
  ): Promise<unknown> {
    this.active()
    const prepared = this.options.serializeArgs?.(args) ?? args
    let rejectClosed!: (error: Error) => void
    const revoked = new Promise<never>((_, reject) => {
      rejectClosed = reject
    })
    this.pending.add(rejectClosed)
    try {
      const call = validateAdapterCall({
        methodHandle,
        args: prepared,
        ...(selector ? { selector } : {}),
      })
      const value = adapterDto(await Promise.race([this.options.invoke(call), revoked]))
      this.active()
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (value.$type === "AdapterMap" && Array.isArray(value.entries))
          return new Map(value.entries as Array<[AdapterId, AdapterValue]>)
        if (value.$type === "AdapterMemberMaps" && Array.isArray(value.entries))
          return new Map(
            (value.entries as Array<[AdapterId, Array<[AdapterId, AdapterValue]>]>).map(
              ([id, members]) => [id, new Map(members)],
            ),
          )
      }
      return value
    } finally {
      this.pending.delete(rejectClosed)
      this.options.discardArgs?.(prepared as AdapterValue[])
    }
  }

  /** 把条目列表转为按 id 索引的 Map。 */
  private map(value: AdapterEntries): Map<AdapterId, AdapterProfile> {
    return new Map(value)
  }
  /** 把成员条目转为两级 Map。 */
  private memberMap(value: AdapterAccount): Map<AdapterId, Map<AdapterId, AdapterProfile>> {
    return new Map(value.members.map(([id, entries]) => [id, this.map(entries)]))
  }
  /** 读取缓存的条目，不存在时抛错。 */
  private cached(entries: AdapterEntries, id: AdapterId): AdapterProfile {
    return entries.find(([key]) => adapterKey(key) === adapterKey(id))?.[1] ?? Object.create(null)
  }
  /** 按选择器取得缓存的资料。 */
  private pick(account: OwnedAccount, selector: AdapterSelector): Row {
    this.active()
    const current = account.descriptor
    const metadata =
      selector.kind === "friend"
        ? this.cached(current.friends, selector.userId)
        : selector.kind === "group"
          ? this.cached(current.groups, selector.groupId)
          : this.cached(
              current.members.find(
                ([id]) => adapterKey(id) === adapterKey(selector.groupId),
              )?.[1] ?? [],
              selector.userId,
            )
    const facade: Row = Object.assign(Object.create(null), metadata, {
      self_id: current.id,
      bot: account.facade,
      info: metadata,
    })
    if (selector.kind !== "group") facade.user_id = selector.userId
    if (selector.kind !== "friend") facade.group_id = selector.groupId
    for (const name of Object.keys(current.entityMethods))
      facade[name] = (...args: unknown[]) => {
        const handle = account.descriptor.entityMethods[name]
        if (!handle) return Promise.reject(new Error(M.nativeSandbox.adapterEntityGone))
        return this.call(handle, args, selector)
      }
    if (selector.kind === "group") {
      facade.pickMember = (userId: unknown) =>
        this.pick(account, { kind: "member", groupId: selector.groupId, userId: adapterId(userId) })
      facade.getMemberMap = () =>
        this.memberMap(account.descriptor).get(selector.groupId) ?? new Map()
    }
    // 核心 prepareEvent 可为此本地代理添加可信 sendFile/forward 方法。
    return facade
  }

  /** 为账号创建对核心可见的外观对象。 */
  private accountFacade(account: OwnedAccount): Row {
    const facade: Row = Object.create(null)
    Object.defineProperties(facade, {
      uin: { enumerable: true, get: () => account.descriptor.id },
      adapter: {
        enumerable: true,
        get: () => this.adapters.get(account.descriptor.adapterHandle)?.facade,
      },
      fl: { enumerable: true, get: () => this.map(account.descriptor.friends) },
      gl: { enumerable: true, get: () => this.map(account.descriptor.groups) },
      gml: { enumerable: true, get: () => this.memberMap(account.descriptor) },
    })
    facade.pickFriend = (id: unknown) =>
      this.pick(account, { kind: "friend", userId: adapterId(id) })
    facade.pickUser = facade.pickFriend
    facade.pickGroup = (id: unknown) =>
      this.pick(account, { kind: "group", groupId: adapterId(id) })
    facade.pickMember = (groupId: unknown, userId: unknown) =>
      this.pick(account, { kind: "member", groupId: adapterId(groupId), userId: adapterId(userId) })
    return facade
  }
  /** 根据沙箱快照刷新账号外观。 */
  private refresh(account: OwnedAccount): void {
    for (const key of Object.keys(account.descriptor.metadata)) {
      if (Object.hasOwn(account.facade, key)) continue
      Object.defineProperty(account.facade, key, {
        enumerable: true,
        get: () => account.descriptor.metadata[key],
      })
    }
    for (const method of Object.keys(account.descriptor.methods))
      if (!Object.hasOwn(account.facade, method))
        account.facade[method] = (...args: unknown[]) => {
          const handle = account.descriptor.methods[method]
          if (!handle) return Promise.reject(new Error(M.nativeSandbox.adapterAccountGone))
          return this.call(handle, args)
        }
  }

  /** 只路由来自本组件已认证原生会话的帧。 */
  receive(input: unknown): void {
    this.active()
    const frame = validateAdapterFrame(input)
    if (frame.type === "register") {
      const descriptor = frame.adapter
      if (this.adapters.has(descriptor.handle) || this.adapters.size >= 8)
        adapterFail("ADAPTER_REGISTRATION_DENIED", "Duplicate or excessive adapter registration")
      // id 表示协议类别，例如 OneBotv11 和 ICQQ 都使用 QQ。
      // 注册身份使用本会话句柄，账号归属另行核验。
      const facade = Object.assign(Object.create(null), {
        id: descriptor.id,
        name: descriptor.name,
        version: descriptor.version,
        path: `native:${this.options.pluginId}:${descriptor.handle}`,
        load: () => this.call(descriptor.loadHandle, []),
      })
      this.adapters.set(descriptor.handle, { descriptor, facade })
      Array.prototype.push.call(this.adapterArray, facade)
      return
    }
    if (frame.type === "account") {
      const descriptor = frame.account,
        key = adapterKey(descriptor.id)
      if (!this.adapters.has(descriptor.adapterHandle))
        adapterFail("ADAPTER_ACCOUNT_DENIED", "Account adapter is not owned by this session")
      const owner = this.owners.get(key)
      if (owner && owner.session !== this.session)
        adapterFail("ADAPTER_ACCOUNT_DENIED", "Another plugin session owns this account")
      let account = this.accounts.get(key)
      if (!account) {
        if (
          this.accounts.size >= 32 ||
          this.protectedIds.has(key) ||
          Object.hasOwn(this.options.bot, key) ||
          Reflect.get(this.options.bot, key) !== undefined
        )
          adapterFail("ADAPTER_ACCOUNT_DENIED", "Account would overwrite existing host state")
        if (
          [...this.accounts.values()].some(
            account => account.descriptor.handle === descriptor.handle,
          )
        )
          adapterFail("ADAPTER_ACCOUNT_DENIED", "Account capability is already assigned")
        account = { descriptor, facade: Object.create(null) }
        account.facade = this.accountFacade(account)
        this.accounts.set(key, account)
        Object.defineProperty(this.options.bot, key, {
          value: account.facade,
          writable: true,
          configurable: true,
          enumerable: true,
        })
      } else if (
        account.descriptor.handle !== descriptor.handle ||
        this.options.bot[key] !== account.facade
      )
        adapterFail("ADAPTER_ACCOUNT_DENIED", "Account identity changed without revocation")
      account.descriptor = descriptor
      this.owners.set(key, { session: this.session, accountHandle: descriptor.handle })
      this.refresh(account)
      return
    }
    const account = [...this.accounts.values()].find(
      account => account.descriptor.handle === frame.accountHandle,
    )
    if (frame.type === "remove") {
      if (account) this.remove(account)
      return
    }
    if (!account || this.owners.get(adapterKey(account.descriptor.id))?.session !== this.session)
      adapterFail("ADAPTER_EVENT_DENIED", "Event account does not belong to this session")
    validateAdapterEvent(frame.event, frame.name, account.descriptor.id)
    const event = Object.assign(Object.create(null), frame.event)
    Object.defineProperty(event, "bot", { value: account.facade })
    Reflect.apply(this.emitCore, this.options.bot, [frame.name, event])
  }

  /** 从核心移除账号。 */
  private remove(account: OwnedAccount): void {
    const key = adapterKey(account.descriptor.id)
    if (this.owners.get(key)?.session !== this.session) {
      this.accounts.delete(key)
      return
    }
    const current = this.options.bot[key]
    if (current === account.facade || current === undefined) {
      if (current === account.facade && !Reflect.deleteProperty(this.options.bot, key))
        adapterFail("ADAPTER_CLEANUP_UNCONFIRMED", "Owned account proxy could not be removed")
      for (let index = this.uin.length - 1; index >= 0; index--)
        if (String(this.uin[index]) === key) Array.prototype.splice.call(this.uin, index, 1)
    }
    this.owners.delete(key)
    this.accounts.delete(key)
  }
  /** 立即撤销能力；系统回收前，由调用方另行请求插件清理。 */
  close(): void {
    if (this.closed && !this.accounts.size && !this.adapters.size) return
    this.closed = true
    const error = new Error(M.nativeSandbox.adapterClosed)
    for (const reject of this.pending) reject(error)
    this.pending.clear()
    const errors: unknown[] = []
    for (const account of [...this.accounts.values()]) {
      try {
        this.remove(account)
      } catch (error) {
        errors.push(error)
      }
    }
    for (const [handle, { facade }] of this.adapters) {
      try {
        for (
          let index = this.adapterArray.indexOf(facade);
          index !== -1;
          index = this.adapterArray.indexOf(facade)
        )
          Array.prototype.splice.call(this.adapterArray, index, 1)
        this.adapters.delete(handle)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, M.nativeSandbox.adapterCleanup)
  }
}
