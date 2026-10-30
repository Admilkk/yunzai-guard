/**
 * 推送给主人的通知统一排版：
 * 第一行“【Yunzai Guard】图标 标题”，其后为“字段：值”与说明行，最后是可选的操作提示。
 * 各行不以标点结尾；空行与空值自动省略。
 */
const brand = "【Yunzai Guard】";
/** 去掉行首尾空白与行尾标点。 */
const tidy = (line) => line.trim().replace(/[。；，.;,]+$/u, "");
/** 组合一条通知。 */
export function notice(title, ...lines) {
    return [
        `${brand}${title}`,
        ...lines.filter((line) => typeof line === "string").map(tidy),
    ]
        .filter(Boolean)
        .join("\n");
}
/** “字段：值”行；值为空时省略整行。 */
export function field(label, value) {
    const text = value === undefined || value === null ? "" : tidy(String(value));
    return text ? `${label}：${text}` : undefined;
}
/** 列出前三项，超出时注明总数；total 用于条目已被截断的情况。 */
export function listed(items, total = items.length) {
    const shown = items.slice(0, 3).join("、");
    return total > 3 ? `${shown} 等 ${total} 个` : shown;
}
//# sourceMappingURL=notice.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("shared/notice.ts", { notice, field, listed })
