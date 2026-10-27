import { M } from "../shared/messages.js"
/** 仅暴露当前用户的非敏感身份，不提供宿主家目录或账号列表。 */
export function linuxSandboxIdentity(user: { username: string; uid: number; gid: number }): {
  passwd: string
  group: string
} {
  if (
    typeof user.username !== "string" ||
    !user.username ||
    user.username.length > 256 ||
    /[:\x00-\x1f\x7f]/.test(user.username) ||
    ![user.uid, user.gid].every(
      value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff,
    )
  )
    throw new Error(M.sandbox.linuxUser)
  return {
    passwd: `${user.username}:x:${user.uid}:${user.gid}::/home:/bin/sh\n`,
    group: `${user.username}:x:${user.gid}:\n`,
  }
}
