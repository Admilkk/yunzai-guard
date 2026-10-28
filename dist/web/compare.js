const maxEntries = 5000;
const pageSize = 100;
const listLimit = 30;
/** 分页取出窗口内的行为事件（不含宿主信息记录）。 */
function collect(read, window, plugin) {
    const entries = [];
    const params = new URLSearchParams({
        scope: "behavior",
        pageSize: String(pageSize),
        from: String(window.from),
        to: String(window.to),
    });
    if (plugin)
        params.set("plugin", plugin);
    let truncated = false;
    for (let page = 1;; page++) {
        params.set("page", String(page));
        const result = read(params);
        entries.push(...result.items);
        if (!result.hasMore)
            break;
        if (entries.length >= maxEntries) {
            truncated = true;
            break;
        }
    }
    return { entries: entries.slice(0, maxEntries), truncated };
}
/** 汇总一个窗口：总数、拦截数、类型分布，以及“类型 + 操作 + 目标”的次数。 */
function tally(window, entries, truncated) {
    const stats = {
        from: window.from,
        to: window.to,
        total: entries.length,
        blocked: 0,
        kinds: {},
        truncated,
    };
    const targets = new Map();
    for (const entry of entries) {
        if (entry.blocked || entry.action === "deny")
            stats.blocked++;
        stats.kinds[entry.kind] = (stats.kinds[entry.kind] ?? 0) + 1;
        const key = `${entry.kind}\0${entry.operation}\0${entry.target}`;
        const item = targets.get(key) ?? {
            kind: entry.kind,
            operation: entry.operation,
            target: entry.target,
            a: 0,
            b: 0,
        };
        item.a++;
        targets.set(key, item);
    }
    return { stats, targets };
}
/** 对比两个时间窗口内的行为，用于判断更新或改配置之后插件做了什么新事。 */
export function compareAudit(read, windows, plugin) {
    const first = collect(read, windows.a, plugin);
    const second = collect(read, windows.b, plugin);
    const a = tally(windows.a, first.entries, first.truncated);
    const b = tally(windows.b, second.entries, second.truncated);
    const merged = new Map();
    for (const [key, item] of a.targets)
        merged.set(key, { ...item });
    for (const [key, item] of b.targets) {
        const existing = merged.get(key);
        if (existing)
            existing.b = item.a;
        else
            merged.set(key, { ...item, a: 0, b: item.a });
    }
    const all = [...merged.values()];
    const byChange = (x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a) || x.target.localeCompare(y.target);
    return {
        ...(plugin ? { plugin } : {}),
        a: a.stats,
        b: b.stats,
        added: all
            .filter(item => item.a === 0)
            .sort(byChange)
            .slice(0, listLimit),
        removed: all
            .filter(item => item.b === 0)
            .sort(byChange)
            .slice(0, listLimit),
        changed: all
            .filter(item => item.a > 0 && item.b > 0 && Math.abs(item.b - item.a) >= Math.max(3, item.a * 0.5))
            .sort(byChange)
            .slice(0, listLimit),
    };
}
//# sourceMappingURL=compare.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("web/compare.ts", { compareAudit })
