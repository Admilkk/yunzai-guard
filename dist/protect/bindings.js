import { isBuiltin } from "node:module";
import { apply, arrayIncludes, error, string } from "./intrinsics.js";
import { M } from "../shared/messages.js";
const builtin = isBuiltin;
const owner = process;
const binding = process.binding;
const queries = ["config", "constants", "util", "uv", "os", "icu", "natives"];
/** 拒绝以 --expose-internals 启动的进程。 */
export function assertNoInternals() {
    if (builtin("internal/test/binding"))
        throw error(M.protect.exposeInternals);
}
/** 限制 process.binding 只能查询常见绑定，并禁用 _linkedBinding。 */
export function installBindingGuard(seal, deny) {
    assertNoInternals();
    // 原始句柄与内部绑定绕过公开模块；仅保留常见查询入口。
    seal(owner, "binding", (input) => {
        const name = string(input);
        if (!arrayIncludes(queries, name))
            return deny("binding-access", name);
        return apply(binding, owner, [name]);
    }, "process.binding");
    seal(owner, "_linkedBinding", (name) => deny("binding-access", `linked:${string(name)}`), "process._linkedBinding");
}
//# sourceMappingURL=bindings.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/bindings.ts", { assertNoInternals, installBindingGuard })
