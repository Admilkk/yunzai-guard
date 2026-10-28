import type { CoreBot } from "./types.js"

declare global {
  class plugin {
    constructor(options: Record<string, unknown>)
    e?: { msg?: string }
    reply(message: string, quote?: boolean): Promise<unknown>
    addCleanup(dispose: () => void | Promise<void>, restore?: () => void | Promise<void>): void
  }
  var Bot: CoreBot & { bot: CoreBot }
  var logger: { error: (...args: unknown[]) => void; info: (...args: unknown[]) => void }
  var start_type: string
}

export {}
