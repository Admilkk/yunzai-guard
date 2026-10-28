import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { M } from "../shared/messages.js";
const defaultMaxBytes = 4 * 1024 * 1024;
/** 返回普通文件的状态，不存在或非普通文件时返回 undefined。 */
function ordinaryFile(file) {
    try {
        const info = fs.lstatSync(file);
        if (!info.isFile() || info.nlink !== 1)
            throw new Error(M.host.logFile);
        return info;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
/** 日志超过上限时保留尾部内容并截断。 */
function rotate(file, size, maxBytes) {
    const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let tail;
    try {
        const info = fs.fstatSync(handle);
        if (!info.isFile() || info.nlink !== 1)
            throw new Error(M.host.logHandle);
        tail = Buffer.alloc(Math.min(size, maxBytes));
        const read = fs.readSync(handle, tail, 0, tail.length, Math.max(0, size - tail.length));
        tail = tail.subarray(0, read);
    }
    finally {
        fs.closeSync(handle);
    }
    fs.rmSync(`${file}.1`, { force: true });
    fs.writeFileSync(`${file}.1`, tail, { flag: "wx", mode: 0o600 });
    fs.unlinkSync(file);
}
/** 删除超过保留天数没有再写入的 host.log 及其轮转文件；maxDays 为 0 时不处理。 */
export function pruneHostLog(directory, maxDays, now = Date.now()) {
    if (!Number.isFinite(maxDays) || maxDays <= 0)
        return 0;
    let removed = 0;
    for (const name of ["host.log", "host.log.1"]) {
        const file = path.join(directory, name);
        try {
            const info = ordinaryFile(file);
            if (!info || now - info.mtimeMs <= maxDays * 86400000)
                continue;
            fs.unlinkSync(file);
            removed++;
        }
        catch {
            // 无法确认或删除时保留原文件。
        }
    }
    return removed;
}
/** 把宿主控制台输出同时写入日志文件。 */
export function installHostLog(directory, { maxBytes = defaultMaxBytes, stdout = process.stdout, stderr = process.stderr, } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
        throw new Error(M.host.logSize);
    const file = path.join(directory, "host.log");
    let failed = false;
    let writing = false;
    const originals = [stdout.write, stderr.write];
    /** 追加一段输出，写入失败后停止记录。 */
    function append(chunk, encoding) {
        if (failed || writing)
            return;
        writing = true;
        try {
            let bytes;
            if (typeof chunk === "string")
                bytes = Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
            else if (ArrayBuffer.isView(chunk))
                bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            else
                return;
            if (!bytes.length)
                return;
            if (bytes.length > maxBytes * 2)
                bytes = bytes.subarray(-maxBytes * 2);
            fs.mkdirSync(directory, { recursive: true });
            let offset = 0;
            while (offset < bytes.length) {
                let size = ordinaryFile(file)?.size ?? 0;
                if (size >= maxBytes) {
                    rotate(file, size, maxBytes);
                    size = 0;
                }
                const length = Math.min(maxBytes - size, bytes.length - offset);
                const handle = fs.openSync(file, fs.constants.O_APPEND |
                    fs.constants.O_CREAT |
                    fs.constants.O_WRONLY |
                    (fs.constants.O_NOFOLLOW ?? 0), 0o600);
                try {
                    const info = fs.fstatSync(handle);
                    if (!info.isFile() || info.nlink !== 1)
                        throw new Error(M.host.logHandle);
                    let written = 0;
                    while (written < length) {
                        const count = fs.writeSync(handle, bytes, offset + written, length - written);
                        if (!count)
                            throw new Error(M.host.logStalled);
                        written += count;
                    }
                }
                finally {
                    fs.closeSync(handle);
                }
                offset += length;
            }
        }
        catch (error) {
            failed = true;
            try {
                Reflect.apply(originals[1], stderr, [
                    `[Yunzai Guard] host.log unavailable: ${error.message}\n`,
                ]);
            }
            catch { }
        }
        finally {
            writing = false;
        }
    }
    const streams = [stdout, stderr];
    const wrappers = streams.map((stream, index) => {
        const write = function (...args) {
            const result = Reflect.apply(originals[index], this, args);
            append(args[0], args[1]);
            return result;
        };
        stream.write = write;
        return write;
    });
    return () => streams.forEach((stream, index) => {
        if (stream.write === wrappers[index])
            stream.write = originals[index];
    });
}
/** 把业务进程的标准输出转发到宿主输出。 */
export function pipeHostOutput(child, stdout = process.stdout, stderr = process.stderr) {
    const pending = [child.stdout, child.stderr].flatMap((source, index) => {
        if (!source)
            return [];
        const target = index === 0 ? stdout : stderr;
        const completion = finished(source, { writable: false, cleanup: true }).then(() => new Promise((resolve, reject) => target.write("", error => (error ? reject(error) : resolve()))));
        source.pipe(target, { end: false });
        return [completion];
    });
    const drained = Promise.all(pending).then(() => { });
    void drained.catch(() => { });
    return async (timeout) => {
        let timer;
        try {
            await Promise.race([
                drained,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(M.host.drainTimeout)), timeout);
                }),
            ]);
        }
        finally {
            clearTimeout(timer);
        }
    };
}
//# sourceMappingURL=log.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/log.ts", { pruneHostLog, installHostLog, pipeHostOutput })
