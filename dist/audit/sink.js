import fs from "node:fs";
import { copyAuditData } from "./protocol.js";
import { M } from "../shared/messages.js";
/** 唯一的同步写入器；回执仅表示追加完成，不保证 fsync 或最终留存。 */
export class AuditSink {
    #options;
    #io;
    #sequence = 0;
    #available = true;
    #framingUnknown = false;
    #written = 0;
    #rejected = 0;
    #unknown = 0;
    #filesEvicted = 0;
    #bytesEvicted = 0;
    #rotationCoverageUnknown = false;
    /** 创建按大小轮转的 JSONL 审计落盘端。 */
    constructor(options) {
        if (!Number.isSafeInteger(options.maxBytes) ||
            options.maxBytes < 1 ||
            !Number.isSafeInteger(options.maxFiles) ||
            options.maxFiles < 1 ||
            options.maxFiles > 100)
            throw new TypeError(M.audit.sinkLimits);
        this.#options = options;
        this.#io = options.io ?? {
            exists: file => fs.existsSync(file),
            size: file => fs.statSync(file).size,
            rename: (source, target) => fs.renameSync(source, target),
            truncate: file => fs.truncateSync(file),
            append: (file, text) => fs.appendFileSync(file, text, { mode: 0o600 }),
        };
    }
    /** 轮转日志文件，淘汰最旧的一份。 */
    #rotate() {
        const { filePath, maxFiles } = this.#options;
        const evicted = maxFiles === 1 ? filePath : `${filePath}.${maxFiles - 1}`;
        const eviction = this.#io.exists(evicted) ? this.#io.size(evicted) : undefined;
        if (maxFiles === 1)
            this.#io.truncate(filePath);
        else
            for (let index = maxFiles - 1; index >= 1; index--) {
                const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
                if (this.#io.exists(source))
                    this.#io.rename(source, `${filePath}.${index}`);
            }
        if (eviction !== undefined) {
            this.#bytesEvicted += eviction;
            this.#filesEvicted++;
        }
    }
    /** 批量追加事件，逐条返回写入回执。 */
    appendBatch(frames) {
        if (frames.length > 256)
            throw new TypeError(M.audit.batchLimit);
        const receipts = new Array(frames.length);
        const encoded = [];
        for (let index = 0; index < frames.length; index++) {
            if (this.#framingUnknown) {
                receipts[index] = { result: "rejected", reason: "sink-error" };
                this.#rejected++;
                continue;
            }
            const frame = frames[index];
            try {
                if (typeof frame.type !== "string" || !frame.type || frame.type.length > 100)
                    throw new TypeError(M.audit.recordType);
                const details = copyAuditData(frame.details ?? {});
                if (!details || Array.isArray(details))
                    throw new TypeError(M.audit.details);
                const sequence = this.#sequence + 1;
                if (!Number.isSafeInteger(sequence))
                    throw new TypeError(M.audit.sequenceExhausted);
                const time = frame.time ?? this.#options.wallNow?.() ?? Date.now();
                if (!Number.isFinite(time))
                    throw new TypeError(M.audit.recordClock);
                const text = JSON.stringify({
                    ...details,
                    sequence,
                    time,
                    hostPid: this.#options.hostPid ?? process.pid,
                    type: frame.type,
                }) + "\n";
                const bytes = Buffer.byteLength(text);
                if (bytes > this.#options.maxBytes) {
                    receipts[index] = { result: "rejected", reason: "oversize" };
                    this.#rejected++;
                    continue;
                }
                // 失败尝试会留下序号缺口；已分配序号不得复用。
                this.#sequence = sequence;
                encoded.push({ index, text, bytes, sequence });
            }
            catch {
                receipts[index] = { result: "rejected", reason: "serialization" };
                this.#rejected++;
            }
        }
        if (!encoded.length)
            return receipts;
        let length = 0;
        try {
            if (this.#io.exists(this.#options.filePath))
                length = this.#io.size(this.#options.filePath);
            if (!Number.isSafeInteger(length) || length < 0)
                throw new Error(M.audit.fileSize);
        }
        catch {
            this.#available = false;
            for (const item of encoded) {
                receipts[item.index] = { result: "rejected", reason: "sink-error", sequence: item.sequence };
                this.#rejected++;
            }
            return receipts;
        }
        let group = [];
        const flush = () => {
            if (!group.length)
                return;
            try {
                this.#io.append(this.#options.filePath, group.map(item => item.text).join(""));
                this.#available = true;
                for (const item of group) {
                    receipts[item.index] = { result: "written", sequence: item.sequence, bytes: item.bytes };
                    this.#written++;
                }
            }
            catch {
                // appendFileSync 可能部分写入后抛错，须保留已写字节并锁定 unknown 状态；
                // 后续成功写入不能静默修复帧边界或确认本批记录。
                this.#available = false;
                this.#framingUnknown = true;
                for (const item of group) {
                    receipts[item.index] = {
                        result: "unknown",
                        reason: "partial-write",
                        sequence: item.sequence,
                    };
                    this.#unknown++;
                }
            }
            group = [];
        };
        for (const item of encoded) {
            if (this.#framingUnknown) {
                receipts[item.index] = { result: "rejected", reason: "sink-error", sequence: item.sequence };
                this.#rejected++;
                continue;
            }
            if (length && length + item.bytes > this.#options.maxBytes) {
                flush();
                if (this.#framingUnknown) {
                    receipts[item.index] = {
                        result: "rejected",
                        reason: "sink-error",
                        sequence: item.sequence,
                    };
                    this.#rejected++;
                    continue;
                }
                try {
                    this.#rotate();
                    length = 0;
                }
                catch {
                    this.#available = false;
                    this.#rotationCoverageUnknown = true;
                    receipts[item.index] = {
                        result: "rejected",
                        reason: "sink-error",
                        sequence: item.sequence,
                    };
                    this.#rejected++;
                    continue;
                }
            }
            group.push(item);
            length += item.bytes;
        }
        flush();
        return receipts;
    }
    /** 追加单条事件。 */
    record(type, details = {}, time) {
        return this.appendBatch([{ type, details, time }])[0];
    }
    /** 返回落盘统计快照。 */
    stats() {
        return {
            lastAllocatedSequence: this.#sequence,
            available: this.#available,
            framingUnknown: this.#framingUnknown,
            written: this.#written,
            rejected: this.#rejected,
            unknown: this.#unknown,
            filesEvicted: this.#filesEvicted,
            bytesEvicted: this.#bytesEvicted,
            rotationCoverageUnknown: this.#rotationCoverageUnknown,
            evidence: "append-completed-without-fsync",
        };
    }
}
//# sourceMappingURL=sink.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("audit/sink.ts", { AuditSink })
