type Row = Record<string, any>

/** 环绕钩子：this 为原调用者，next 以给定参数继续调用内层并返回其结果。 */
export type LoaderHook<A extends unknown[] = any[]> = (
  this: Row,
  next: (...args: any[]) => any,
  ...args: A
) => unknown

interface Chain {
  original: Function
  hooks: LoaderHook[]
}

const engines = new WeakMap<object, LoaderHooks>()

/**
 * 核心 PluginsLoader 的钩子引擎：每个方法只替换一次，各模块登记的环绕钩子按登记顺序由外到内执行。
 * 同步方法保持同步，返回值与 this 原样透传；同一加载器共用一个引擎。
 */
export class LoaderHooks {
  readonly loader: Row
  readonly #chains = new Map<string, Chain>()
  readonly #trusted = new Set<string>()

  private constructor(loader: Row) {
    this.loader = loader
  }

  /** 取得加载器的钩子引擎，首次调用时创建。 */
  static of(loader: Row): LoaderHooks {
    let engine = engines.get(loader)
    if (!engine) engines.set(loader, (engine = new LoaderHooks(loader)))
    return engine
  }

  /** 登记环绕钩子；先登记的在外层。方法不存在时不登记并返回 false。 */
  around<A extends unknown[]>(method: string, hook: LoaderHook<A>): boolean {
    const chain = this.#chain(method)
    if (!chain) return false
    chain.hooks.push(hook as LoaderHook)
    return true
  }

  /** 未经任何钩子的原方法，供需要绕开外层逻辑的回滚路径使用。 */
  original(method: string): Function | undefined {
    return this.#chain(method)?.original
  }

  /** 标记 Guard 自有的插件：监控与策略不统计、不拦截它。 */
  trust(key: string): void {
    this.#trusted.add(key)
  }

  /** 是否为 Guard 自有的插件。 */
  trusted(key: unknown): boolean {
    return typeof key === "string" && this.#trusted.has(key)
  }

  /** 首次登记时替换方法为分派函数。 */
  #chain(method: string): Chain | undefined {
    const existing = this.#chains.get(method)
    if (existing) return existing
    const original: unknown = this.loader[method]
    if (typeof original !== "function") return undefined
    const chain: Chain = { original, hooks: [] }
    this.#chains.set(method, chain)
    const call = (self: Row, index: number, args: unknown[]): unknown => {
      const hook = chain.hooks[index]
      return hook
        ? Reflect.apply(hook, self, [(...next: unknown[]) => call(self, index + 1, next), ...args])
        : Reflect.apply(chain.original, self, args)
    }
    this.loader[method] = function (this: Row, ...args: unknown[]) {
      return call(this, 0, args)
    }
    return chain
  }
}
