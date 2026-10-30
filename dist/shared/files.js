import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { M } from "./messages.js";
/**
 * 读取 JSON 文件。文件不存在时返回 undefined；超过大小上限或内容损坏时抛出，
 * 由调用方决定按首次运行处理、视为熔断还是报错。
 */
export function readJsonFile(file, maxBytes = 4 * 1024 * 1024) {
    let text;
    try {
        if (fs.statSync(file).size > maxBytes)
            throw new Error(M.files.jsonOversize(file));
        text = fs.readFileSync(file, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    return JSON.parse(text);
}
/**
 * 原子写入文本：先写同目录临时文件再改名替换，进程中途退出也不会留下半截文件。
 * 权限 0600，按需创建目录；失败时清理临时文件并抛出。
 */
export function writeTextFile(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        fs.writeFileSync(temporary, text, { mode: 0o600 });
        fs.renameSync(temporary, file);
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}
/** 原子写入 JSON，见 writeTextFile。 */
export function writeJsonFile(file, value, options = {}) {
    writeTextFile(file, `${JSON.stringify(value, null, options.pretty ? 2 : 0)}\n`);
}
/** 是否为普通文件：不是符号链接且只有一个硬链接，避免链接把读写引向别处；可附加大小上限。 */
export function isOrdinaryFile(stat, maxBytes = Infinity) {
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= maxBytes;
}
//# sourceMappingURL=files.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("shared/files.ts", { readJsonFile, writeTextFile, writeJsonFile, isOrdinaryFile })
