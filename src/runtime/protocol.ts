import type { GuardSettings } from "../shared/types.js"

export interface RuntimeManifest {
  version: 1
  generation: number
  projectId: string
  /** 宿主固定的控制目录，不随子进程 cwd 漂移。 */
  stateDir?: string
  settings: GuardSettings
  endpoint: string
  token: string
}
