import { validateNativeDescriptor } from "./validation.js";
import { M } from "../shared/messages.js";
/** 统计注册项数量。 */
const count = (value) => (Array.isArray(value) ? value.length : value ? 1 : 0);
/** 跨文件和元数据更新累计限制宿主调度及 Handler 分配，不只限制单帧。 */
export class NativeRegistrationBudget {
    plugins = new Map();
    /** 检查注册是否冲突。 */
    check(id, values) {
        let tasks = 0, handlers = 0, rules = 0;
        for (const { descriptor } of values.values()) {
            const metadata = descriptor.metadata;
            const taskValues = Array.isArray(metadata.task)
                ? metadata.task
                : metadata.task
                    ? [metadata.task]
                    : [];
            tasks += taskValues.filter(task => task.cron && task.fnc).length;
            handlers += Array.isArray(metadata.handler)
                ? metadata.handler.length
                : metadata.handler
                    ? Object.keys(metadata.handler).length
                    : 0;
            rules += count(metadata.rule);
        }
        if (values.size > 256 || tasks > 64 || handlers > 128 || rules > 4096)
            throw new Error(M.nativeSandbox.registrationBudget(id));
        let allTasks = tasks;
        for (const [other, entries] of this.plugins) {
            if (other === id)
                continue;
            for (const { descriptor } of entries.values()) {
                const input = descriptor.metadata.task;
                const values = Array.isArray(input) ? input : input ? [input] : [];
                allTasks += values.filter(task => task.cron && task.fnc).length;
            }
        }
        if (allTasks > 256)
            throw new Error(M.nativeSandbox.schedulerBudget);
    }
    /** 预留插件文件的类注册。 */
    reserve(id, file, descriptors) {
        const candidate = new Map(this.plugins.get(id));
        if ([...candidate.values()].some(entry => entry.file === file))
            throw new Error(M.nativeSandbox.fileRegistered);
        for (const raw of descriptors) {
            const descriptor = validateNativeDescriptor(raw), key = `${file}\0${descriptor.id}`;
            if (candidate.has(key))
                throw new Error(M.nativeSandbox.classDuplicate);
            candidate.set(key, { file, descriptor });
        }
        this.check(id, candidate);
        this.plugins.set(id, candidate);
    }
    /** 更新一个类注册。 */
    update(id, file, raw) {
        const candidate = new Map(this.plugins.get(id)), descriptor = validateNativeDescriptor(raw), key = `${file}\0${descriptor.id}`;
        if (!candidate.has(key))
            throw new Error(M.nativeSandbox.updateUnregistered);
        candidate.set(key, { file, descriptor });
        this.check(id, candidate);
        this.plugins.set(id, candidate);
    }
    /** 释放插件或单个文件的注册。 */
    release(id, file) {
        if (file === undefined) {
            this.plugins.delete(id);
            return;
        }
        const values = this.plugins.get(id);
        if (!values)
            return;
        for (const [key, entry] of values)
            if (entry.file === file)
                values.delete(key);
        if (!values.size)
            this.plugins.delete(id);
    }
}
//# sourceMappingURL=registrations.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/registrations.ts", { NativeRegistrationBudget })
