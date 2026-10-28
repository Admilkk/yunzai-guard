import { installInheritedRuntime } from "./index.js";
import { M } from "../shared/messages.js";
const runtime = installInheritedRuntime();
if (!runtime)
    throw new Error(M.runtime.metadataMissing);
await runtime.ready;
//# sourceMappingURL=child-preload.js.map