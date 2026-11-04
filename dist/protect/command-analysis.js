import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommandExecutable } from "./command-resolution.js";
import { isImplicitSystemShell } from "./command-shell.js";
import { apply, arrayIncludes, arrayIsArray, arrayPush, arraySlice, arraySome, objectDescriptor, objectKeys, objectCreate, regexpTest, stringIndexOf, stringLower, stringSlice, stringStartsWith, } from "./intrinsics.js";
const resolve = path.resolve;
const basename = path.basename;
const dirname = path.dirname;
const isAbsolute = path.isAbsolute;
const separator = path.sep;
const cwd = process.cwd.bind(process);
const urlPath = fileURLToPath;
const stat = fs.statSync;
const isDirectory = fs.Stats.prototype.isDirectory;
const windows = process.platform === "win32";
const truth = Boolean;
const maxText = 128 * 1024;
const maxTokens = 4096;
const maxCommands = 256;
const maxDirectories = 32;
const exec = RegExp.prototype.exec;
const split = String.prototype.split;
const trim = String.prototype.trim;
const test = regexpTest;
const match = (expression, value) => apply(exec, expression, [value]);
const trimmed = (value) => apply(trim, value, []);
const pieces = (value, delimiter) => apply(split, value, [delimiter]);
/** 只读取自有数据属性，启动快照不再调用业务 getter。 */
function own(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    return objectDescriptor(value, key)?.value;
}
function snapshotEnvironment(value) {
    const result = objectCreate(null);
    const source = value && typeof value === "object" ? value : process.env;
    const keys = objectKeys(source);
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        const property = objectDescriptor(source, key);
        if (property && "value" in property)
            result[key] = property.value;
    }
    return result;
}
function setEnvironment(env, key, value) {
    if (windows) {
        const keys = objectKeys(env);
        for (let index = 0; index < keys.length; index++)
            if (stringLower(keys[index]) === stringLower(key))
                delete env[keys[index]];
    }
    if (value === undefined)
        delete env[key];
    else
        env[key] = value;
}
function program(value) {
    const names = pieces(value, "\\");
    const unix = pieces(names[names.length - 1], "/");
    const name = stringLower(unix[unix.length - 1]);
    return test(/\.(?:exe|com)$/i, name) ? stringSlice(name, 0, -4) : name;
}
function pathText(value) {
    if (typeof value === "string")
        return value;
    if (!value || typeof value !== "object")
        return undefined;
    try {
        return urlPath(value);
    }
    catch {
        return undefined;
    }
}
function targetPath(value, directory) {
    if (!value || value === "-" || test(/\0/, value))
        return undefined;
    if (test(/^file:/i, value)) {
        try {
            return urlPath(value);
        }
        catch {
            return undefined;
        }
    }
    if (test(/^[a-z][a-z\d+.-]*:\/\//i, value))
        return undefined;
    if (windows && test(/^[a-z]:(?:$|[^\\/])/i, value))
        return undefined;
    if (windows && test(/^[\\/](?![\\/])/, value)) {
        if (!test(/^[a-z]:[\\/]/i, directory))
            return undefined;
        return stringSlice(directory, 0, 2) + value;
    }
    if (isAbsolute(value))
        return value;
    return `${directory}${test(/[\\/]$/, directory) ? "" : separator}${value}`;
}
/** 只采集明确路径；任意普通参数不能都当成输出文件。 */
function looksLikePath(value) {
    return (test(/^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/]|file:)/i, value) ||
        (!stringStartsWith(value, "-") && test(/[\\/]/, value)));
}
function informational(argv) {
    return (argv.length === 1 &&
        arrayIncludes(["--version", "-v", "-V", "--help", "-h", "-?", "/?", "--v8-options"], argv[0]));
}
/** 有界拆分常见 shell 词法；不执行变量、替换、展开或任何命令。 */
function tokens(text, syntax) {
    const values = [];
    if (text.length > maxText)
        return { values, limited: true };
    let dynamic = false;
    let word = "", started = false, quote = "";
    const flush = () => {
        if (started)
            arrayPush(values, { value: word });
        word = "";
        started = false;
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (values.length >= maxTokens)
            return { values, limited: true };
        if (quote !== "'" &&
            ((syntax === "posix" && char === "`") ||
                (syntax !== "cmd" && char === "$" && text[index + 1] === "(")))
            dynamic = true;
        if (quote) {
            if (syntax === "powershell" && quote === "'" && char === "'" && text[index + 1] === "'") {
                word += "'";
                index++;
            }
            else if (syntax === "powershell" &&
                quote === '"' &&
                char === "`" &&
                index + 1 < text.length)
                word += text[++index];
            else if (char === quote)
                quote = "";
            else if (char === "\\" &&
                quote === '"' &&
                syntax === "posix" &&
                index + 1 < text.length &&
                test(/["\\$`\n]/, text[index + 1]))
                word += text[++index];
            else
                word += char;
            continue;
        }
        if (char === '"' || (syntax !== "cmd" && char === "'")) {
            started = true;
            quote = char;
        }
        else if ((char === "\\" && syntax === "posix") ||
            (char === "^" && syntax === "cmd") ||
            (char === "`" && syntax === "powershell")) {
            started = true;
            if (index + 1 < text.length)
                word += text[++index];
            else
                word += char;
        }
        else if (char === " " || char === "\t")
            flush();
        else if (test(/[;&|<>\r\n()]/, char)) {
            // 2>file 的 2 是描述符；普通数字参数仍原样保留。
            if ((char === ">" || char === "<") && test(/^\d+$/, word)) {
                word = "";
                started = false;
            }
            flush();
            let operator = char;
            const next = text[index + 1];
            if (next === char && test(/[&|<>]/, char))
                operator += text[++index];
            if ((char === ">" || char === "<") && text[index + 1] === "&")
                operator += text[++index];
            arrayPush(values, { value: operator, operator: true });
        }
        else {
            started = true;
            word += char;
        }
    }
    flush();
    return { values, limited: dynamic || truth(quote) || values.length > maxTokens };
}
/** 提取可确定的执行与文件目标，不把静态分析当作系统文件权限边界。 */
export function analyzeCommand(operation, input) {
    const array = arrayIsArray(input[1]) ? input[1] : undefined;
    const at = array || (input[1] == null && input.length >= 3) ? 2 : 1;
    const options = input[at];
    const requestedCwd = own(options, "cwd");
    const base = pathText(requestedCwd);
    const resolvedDirectory = base === undefined ? cwd() : targetPath(base, cwd());
    const directory = resolvedDirectory ?? cwd();
    const entry = typeof input[0] === "string" ? input[0] : operation === "fork" ? (pathText(input[0]) ?? "") : "";
    const analysis = {
        script: operation === "fork",
        targets: [],
        cwd: resolve(directory),
        executable: entry,
        limited: undefined,
    };
    if ((requestedCwd != null && base === undefined) || resolvedDirectory === undefined)
        analysis.limited = true;
    const environment = own(options, "env");
    const shell = operation === "exec" || operation === "execSync" || truth(own(options, "shell"));
    const requestedShell = own(options, "shell");
    const shellName = typeof requestedShell === "string" ? program(requestedShell) : "";
    let currentSyntax = arrayIncludes(["pwsh", "powershell"], shellName)
        ? "powershell"
        : arrayIncludes(["sh", "bash", "dash", "ash", "zsh", "ksh", "fish"], shellName)
            ? "posix"
            : windows
                ? "cmd"
                : "posix";
    let shellDepth = 0;
    const activeShell = () => shell || shellDepth > 0;
    if (shell)
        analysis.executable = "shell-command";
    const directories = [directory];
    let total = 0, commands = 0;
    const add = (value, access, ancestors = false) => {
        if (typeof value !== "string")
            return;
        if (windows && test(/^[a-z]:(?:$|[^\\/])/i, value)) {
            analysis.limited = true;
            return;
        }
        if (activeShell() && (test(/[$`]/, value) || (windows && test(/%[^%]+%/, value)))) {
            // 不执行 shell 求值，也不把动态写目标漏报为普通字面路径。
            analysis.limited = true;
            return;
        }
        const wildcard = match(/[*?[]/, value);
        if (wildcard) {
            const prefix = stringSlice(value, 0, wildcard.index);
            value = test(/[\\/]$/, prefix) ? prefix : dirname(prefix || ".");
            ancestors = true;
        }
        for (let index = 0; index < directories.length; index++) {
            const name = targetPath(value, directories[index]);
            if (!name)
                continue;
            const display = resolve(name);
            const raw = name === display ? undefined : name;
            if (analysis.targets.length >= maxTokens) {
                analysis.limited = true;
                return;
            }
            let found = false;
            for (let known = 0; known < analysis.targets.length; known++) {
                const target = analysis.targets[known];
                if (target.path === display &&
                    target.raw === raw &&
                    target.access === access &&
                    truth(target.ancestors) === ancestors) {
                    found = true;
                    break;
                }
            }
            if (!found)
                arrayPush(analysis.targets, {
                    path: display,
                    ...(raw ? { raw } : {}),
                    access,
                    ...(ancestors ? { ancestors } : {}),
                });
        }
    };
    const rememberCwd = (value) => {
        if (test(/[$`*?[]/, value) ||
            (windows && (test(/%[^%]+%/, value) || test(/^[a-z]:(?:$|[^\\/])/i, value)))) {
            analysis.limited = true;
            return;
        }
        const previous = directories.length;
        for (let index = 0; index < previous; index++) {
            const name = targetPath(value, directories[index]);
            if (!name || arrayIncludes(directories, name))
                continue;
            if (directories.length >= maxDirectories) {
                analysis.limited = true;
                return;
            }
            // 同时保留原 cwd，条件分支或 cd 失败不会令后续相对目标漏检。
            arrayPush(directories, name);
        }
    };
    const inspect = (words, depth = 0, inheritedEnvironment = environment) => {
        if (!words.length)
            return;
        if (++commands > maxCommands || depth > 12) {
            analysis.limited = true;
            return;
        }
        let first = 0;
        let launchEnvironment = inheritedEnvironment;
        while (first < words.length && test(/^[a-z_][a-z\d_]*=/i, words[first])) {
            if (launchEnvironment === inheritedEnvironment)
                launchEnvironment = snapshotEnvironment(inheritedEnvironment);
            const assignment = words[first];
            const equals = stringIndexOf(assignment, "=");
            setEnvironment(launchEnvironment, stringSlice(assignment, 0, equals), stringSlice(assignment, equals + 1));
            first++;
        }
        if (first >= words.length) {
            if (activeShell())
                analysis.limited = true;
            return;
        }
        const executable = words[first];
        if (activeShell() && (test(/[$`]/, executable) || (windows && test(/%[^%]+%/, executable)))) {
            analysis.limited = true;
            return;
        }
        const name = program(executable);
        const argv = arraySlice(words, first + 1);
        if (shell && analysis.executable === "shell-command")
            analysis.executable = executable;
        if (activeShell() && argv.length && arrayIncludes(["export", "unset", "set", "path"], name)) {
            // 不模拟跨命令环境状态；后续 PATH、PATHEXT 等变化不能沿用旧快照。
            analysis.limited = true;
            return;
        }
        if (looksLikePath(executable))
            add(executable, "read");
        const builtin = activeShell() &&
            !test(/[\\/:]|\.(?:exe|com)$/i, executable) &&
            arrayIncludes(currentSyntax === "cmd"
                ? [
                    "echo",
                    "echo.",
                    "ver",
                    "rem",
                    "cd",
                    "chdir",
                    "pushd",
                    "popd",
                    "type",
                    "dir",
                    "copy",
                    "move",
                    "ren",
                    "rename",
                    "del",
                    "erase",
                    "rd",
                    "rmdir",
                    "mkdir",
                    "md",
                ]
                : currentSyntax === "powershell"
                    ? [
                        "write-output",
                        "write-host",
                        "echo",
                        "set-content",
                        "add-content",
                        "out-file",
                        "remove-item",
                        "move-item",
                        "copy-item",
                        "rename-item",
                        "new-item",
                        "set-item",
                        "get-content",
                        "get-item",
                        "set-location",
                    ]
                    : ["echo", "printf", "pwd", "true", "false", "test", "[", "cd", "pushd", "popd"], name);
        if (!builtin)
            for (let index = 0; index < directories.length; index++) {
                const resolved = resolveCommandExecutable(executable, directories[index], launchEnvironment, activeShell());
                if (resolved.limited)
                    analysis.limited = true;
                if (resolved.script || (resolved.node && !informational(argv)))
                    analysis.script = true;
                if (resolved.path)
                    add(resolved.path, "read");
            }
        if (name === "env") {
            let next = 0;
            const env = snapshotEnvironment(launchEnvironment);
            while (next < argv.length) {
                const value = argv[next];
                if (value === "--") {
                    next++;
                    break;
                }
                if (value === "-i" || value === "--ignore-environment" || value === "-") {
                    const keys = objectKeys(env);
                    for (let index = 0; index < keys.length; index++)
                        delete env[keys[index]];
                    next++;
                    continue;
                }
                if (value === "-S" ||
                    value === "--split-string" ||
                    stringStartsWith(value, "-S") ||
                    stringStartsWith(value, "--split-string=")) {
                    analysis.script = true;
                    analysis.limited = true;
                    return;
                }
                if (value === "-u" ||
                    value === "--unset" ||
                    stringStartsWith(value, "--unset=") ||
                    stringStartsWith(value, "-u")) {
                    const key = value === "-u" || value === "--unset"
                        ? argv[++next]
                        : stringStartsWith(value, "--unset=")
                            ? stringSlice(value, 8)
                            : stringSlice(value, 2);
                    if (typeof key !== "string") {
                        analysis.limited = true;
                        return;
                    }
                    setEnvironment(env, key);
                    next++;
                    continue;
                }
                if (value === "-C" ||
                    value === "--chdir" ||
                    stringStartsWith(value, "--chdir=") ||
                    stringStartsWith(value, "-C")) {
                    const nextDirectory = value === "-C" || value === "--chdir"
                        ? argv[++next]
                        : stringStartsWith(value, "--chdir=")
                            ? stringSlice(value, 8)
                            : stringSlice(value, 2);
                    if (typeof nextDirectory !== "string") {
                        analysis.limited = true;
                        return;
                    }
                    rememberCwd(nextDirectory);
                    next++;
                    continue;
                }
                if (test(/^[a-z_][a-z\d_]*=/i, value)) {
                    const equals = stringIndexOf(value, "=");
                    setEnvironment(env, stringSlice(value, 0, equals), stringSlice(value, equals + 1));
                    next++;
                    continue;
                }
                if (stringStartsWith(value, "-")) {
                    analysis.limited = true;
                    return;
                }
                break;
            }
            inspect(arraySlice(argv, next), depth + 1, env);
            return;
        }
        if (arrayIncludes(["command", "exec", "nohup", "sudo", "doas", "setsid", "nice", "timeout", "stdbuf", "time"], name)) {
            if (name === "command" && arrayIncludes(["-v", "-V"], argv[0]))
                return;
            if (informational(argv))
                return;
            const valueOptions = name === "exec"
                ? ["-a"]
                : name === "nice"
                    ? ["-n", "--adjustment"]
                    : name === "stdbuf"
                        ? ["-i", "-o", "-e", "--input", "--output", "--error"]
                        : name === "timeout"
                            ? ["-s", "--signal", "-k", "--kill-after"]
                            : name === "time"
                                ? ["-o", "--output", "-f", "--format"]
                                : name === "sudo"
                                    ? [
                                        "-u",
                                        "--user",
                                        "-g",
                                        "--group",
                                        "-h",
                                        "--host",
                                        "-p",
                                        "--prompt",
                                        "-C",
                                        "--close-from",
                                        "-D",
                                        "--chdir",
                                        "-r",
                                        "--role",
                                        "-t",
                                        "--type",
                                        "-T",
                                        "--command-timeout",
                                        "-a",
                                        "--auth-type",
                                        "-U",
                                        "--other-user",
                                    ]
                                    : name === "doas"
                                        ? ["-u", "-C"]
                                        : [];
            const flagOptions = name === "command"
                ? ["-v", "-V"]
                : name === "exec"
                    ? ["-c", "-l"]
                    : name === "timeout"
                        ? ["--preserve-status", "--foreground", "-v", "--verbose"]
                        : name === "time"
                            ? ["-a", "--append", "-v", "--verbose", "-p", "--portability", "-q", "--quiet"]
                            : name === "setsid"
                                ? ["-c", "--ctty", "-f", "--fork", "-w", "--wait"]
                                : name === "sudo"
                                    ? [
                                        "-E",
                                        "--preserve-env",
                                        "-H",
                                        "--set-home",
                                        "-n",
                                        "--non-interactive",
                                        "-S",
                                        "--stdin",
                                        "-b",
                                        "--background",
                                        "-P",
                                        "--preserve-groups",
                                        "-k",
                                        "--reset-timestamp",
                                        "-K",
                                        "--remove-timestamp",
                                        "-B",
                                        "--bell",
                                        "-A",
                                        "--askpass",
                                    ]
                                    : name === "doas"
                                        ? ["-n", "-L"]
                                        : [];
            let next = 0;
            while (next < argv.length) {
                const value = argv[next];
                if (value === "--") {
                    next++;
                    break;
                }
                if (test(/^[a-z_][a-z\d_]*=/i, value)) {
                    analysis.limited = true;
                    return;
                }
                if (!stringStartsWith(value, "-"))
                    break;
                if (arrayIncludes(["sudo", "doas"], name) &&
                    arrayIncludes(["-s", "--shell", "-i", "--login", "-e", "--edit"], value)) {
                    analysis.script = true;
                    analysis.limited = true;
                    return;
                }
                const equals = stringIndexOf(value, "=");
                let option = equals > 0 ? stringSlice(value, 0, equals) : value;
                let bound = equals > 0 ? stringSlice(value, equals + 1) : undefined;
                if (bound === undefined &&
                    value.length > 2 &&
                    !stringStartsWith(value, "--") &&
                    arrayIncludes(valueOptions, stringSlice(value, 0, 2))) {
                    option = stringSlice(value, 0, 2);
                    bound = stringSlice(value, 2);
                }
                if (arrayIncludes(valueOptions, option)) {
                    bound ??= argv[++next];
                    if (bound === undefined) {
                        analysis.limited = true;
                        return;
                    }
                    if (name === "time" && arrayIncludes(["-o", "--output"], option))
                        add(bound, "write");
                    if (name === "sudo" && arrayIncludes(["-D", "--chdir"], option))
                        rememberCwd(bound);
                }
                else if ((bound === undefined && arrayIncludes(flagOptions, option)) ||
                    (name === "nice" && test(/^-\d+$/, value)) ||
                    (name === "exec" && test(/^-[cl]+$/, value)) ||
                    (name === "sudo" && option === "--preserve-env" && bound !== undefined)) {
                    if (name === "command" && arrayIncludes(["-v", "-V"], option))
                        return;
                    if (name === "exec" && test(/c/, value))
                        launchEnvironment = objectCreate(null);
                }
                else {
                    analysis.limited = true;
                    return;
                }
                next++;
            }
            if (name === "timeout")
                next++;
            inspect(arraySlice(argv, next), depth + 1, launchEnvironment);
            return;
        }
        if (name === "busybox" && argv.length) {
            inspect(argv, depth + 1, launchEnvironment);
            return;
        }
        const interpreter = (activeShell() && arrayIncludes([".", "source", "eval"], name)) ||
            test(/^(?:sh|bash|dash|ash|zsh|ksh|fish|cmd|powershell|pwsh|node|nodejs|deno|bun|npm|npx|pnpm|yarn|corepack|bunx|python(?:\d+(?:\.\d+)*)?|pypy(?:\d+)?|perl|ruby|php|lua(?:\d+(?:\.\d+)*)?|luajit|rscript|tclsh|wish|awk|gawk|mawk|cscript|wscript|mshta|jsc|d8)$/i, name);
        if ((interpreter && !informational(argv)) ||
            test(/\.(?:[cm]?js|jsx|ts|tsx|sh|bash|zsh|fish|py|pyw|pl|rb|php|lua|ps1|bat|cmd|vbs|wsf)$/i, executable))
            analysis.script = true;
        if (interpreter) {
            if (name === "eval") {
                let command = "";
                for (let index = 0; index < argv.length; index++)
                    command += `${index ? " " : ""}${argv[index]}`;
                inspectShell(command, depth + 1, currentSyntax, launchEnvironment);
                return;
            }
            for (let index = 0; index < argv.length; index++) {
                const value = argv[index];
                if (arrayIncludes(["-c", "/c", "/C", "-Command", "-command"], value) && argv[index + 1]) {
                    if (arrayIncludes(["sh", "bash", "dash", "ash", "zsh", "ksh", "fish", "cmd", "powershell", "pwsh"], name)) {
                        let command = argv[index + 1];
                        if (arrayIncludes(["cmd", "powershell", "pwsh"], name))
                            for (let next = index + 2; next < argv.length; next++)
                                command += ` ${argv[next]}`;
                        inspectShell(command, depth + 1, name === "cmd"
                            ? "cmd"
                            : arrayIncludes(["powershell", "pwsh"], name)
                                ? "powershell"
                                : "posix", launchEnvironment);
                    }
                    else
                        index++;
                }
                else if (arrayIncludes(["-e", "--eval", "-p", "--print", "-EncodedCommand", "-encodedcommand"], value))
                    index++;
                else if (!stringStartsWith(value, "-"))
                    add(value, name === "perl" && arraySome(argv, flag => test(/^-[a-z]*i/i, flag)) ? "write" : "read");
            }
            return;
        }
        const operands = [];
        let literal = false;
        const optionValue = (value) => value === "--reference" ||
            (arrayIncludes(["cp", "mv", "install", "ln"], name) &&
                arrayIncludes(["--suffix", "-S", "--target-directory", "-t"], value)) ||
            (name === "install" &&
                arrayIncludes(["--mode", "--owner", "--group", "-m", "-o", "-g"], value)) ||
            (name === "touch" && arrayIncludes(["--date", "-d", "--time", "-t", "-r"], value)) ||
            (name === "truncate" && arrayIncludes(["--size", "-s", "-r"], value));
        for (let index = 0; index < argv.length; index++) {
            const value = argv[index];
            if (value === "--" && !literal) {
                literal = true;
                continue;
            }
            if (!literal && stringStartsWith(value, "-")) {
                if (stringStartsWith(value, "--reference="))
                    add(stringSlice(value, 12), "read");
                if (optionValue(value) && index + 1 < argv.length) {
                    if (value === "--reference" || value === "-r")
                        add(argv[index + 1], "read");
                    index++;
                }
                continue;
            }
            // Windows /switch 不是根路径；POSIX /path 是正常操作数。
            if (windows && test(/^\/[a-z](?:[:+-].*)?$/i, value))
                continue;
            arrayPush(operands, value);
        }
        if (arrayIncludes(["cd", "chdir", "pushd"], name)) {
            if (operands[0])
                rememberCwd(operands[0]);
            return;
        }
        if (arrayIncludes(["echo", "echo.", "printf", "pwd", "true", "false", "test", "[", "ver", "rem"], name))
            return;
        if (arrayIncludes([
            "rm",
            "rmdir",
            "unlink",
            "del",
            "erase",
            "rd",
            "deltree",
            "chmod",
            "chown",
            "chgrp",
            "attrib",
            "icacls",
            "takeown",
            "remove-item",
            "ri",
            "clear-item",
        ], name)) {
            // chmod/chown 首个普通参数是 mode/owner；--reference 形式没有该参数。
            const reference = arraySome(argv, value => stringStartsWith(value, "--reference"));
            const skip = !reference &&
                (arrayIncludes(["chown", "chgrp"], name) ||
                    (name === "chmod" &&
                        truth(operands[0]) &&
                        test(/^(?:[0-7]+|[ugoa]*[+\-=][rwxXstugo,=+\-]*)$/, operands[0])))
                ? 1
                : 0;
            for (let index = skip; index < operands.length; index++)
                add(operands[index], "write", true);
            return;
        }
        if (arrayIncludes([
            "touch",
            "truncate",
            "tee",
            "mkdir",
            "mkfifo",
            "mknod",
            "set-content",
            "add-content",
            "out-file",
            "clear-content",
            "set-item",
            "set-itemproperty",
            "new-item",
            "sc",
            "ac",
            "ni",
        ], name)) {
            for (let index = 0; index < operands.length; index++)
                add(operands[index], "write");
            return;
        }
        if (arrayIncludes(["ren", "rename", "rename-item"], name)) {
            for (let index = 0; index < operands.length; index++)
                add(operands[index], "write", true);
            return;
        }
        if (name === "robocopy") {
            if (operands[0])
                add(operands[0], "read", true);
            if (operands[1])
                add(operands[1], "write", true);
            return;
        }
        if (arrayIncludes(["cp", "copy", "xcopy", "install", "mv", "move", "copy-item", "move-item", "ln", "link"], name)) {
            let destination = operands[operands.length - 1];
            let sources = arraySlice(operands, 0, operands.length - 1);
            if (operands.length === 1 && arrayIncludes(["copy", "xcopy", "ln"], name)) {
                destination = ".";
                sources = operands;
            }
            if (name === "copy-item" || name === "move-item") {
                const namedSources = [], positional = [];
                let namedDestination;
                for (let index = 0; index < argv.length; index++) {
                    const value = argv[index];
                    const parameter = match(/^-(path|literalpath|destination)(?::(.*))?$/i, value);
                    if (parameter) {
                        const bound = parameter[2] ?? argv[++index];
                        if (typeof bound !== "string")
                            continue;
                        if (stringLower(parameter[1]) === "destination")
                            namedDestination = bound;
                        else
                            arrayPush(namedSources, bound);
                    }
                    else if (!stringStartsWith(value, "-"))
                        arrayPush(positional, value);
                }
                if (namedDestination !== undefined || namedSources.length) {
                    destination = namedDestination ?? positional[positional.length - 1] ?? ".";
                    sources = namedSources.length ? namedSources : positional;
                }
            }
            for (let index = 0; index < argv.length; index++)
                if ((argv[index] === "-t" || argv[index] === "--target-directory") && argv[index + 1]) {
                    destination = argv[index + 1];
                    sources = operands;
                }
                else if (stringStartsWith(argv[index], "--target-directory=")) {
                    destination = stringSlice(argv[index], 19);
                    sources = operands;
                }
                else if (stringStartsWith(argv[index], "-t") &&
                    argv[index].length > 2 &&
                    arrayIncludes(["cp", "mv", "install", "ln"], name)) {
                    destination = stringSlice(argv[index], 2);
                    sources = operands;
                }
            const moving = name === "mv" || name === "move" || name === "move-item";
            const linking = name === "ln" || name === "link";
            for (let index = 0; index < sources.length; index++)
                add(sources[index], moving || linking ? "write" : "read", true);
            if (!destination)
                return;
            if (!sources.length) {
                add(destination, "write");
                return;
            }
            for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex++) {
                const base = directories[directoryIndex];
                const output = targetPath(destination, base);
                if (!output)
                    continue;
                let intoDirectory = false;
                try {
                    intoDirectory = apply(isDirectory, stat(output), []);
                }
                catch { }
                for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
                    const source = targetPath(sources[sourceIndex], base);
                    if (!source)
                        continue;
                    let directorySource = false;
                    try {
                        directorySource = apply(isDirectory, stat(source), []);
                    }
                    catch { }
                    const sourceName = basename(source);
                    const actual = intoDirectory &&
                        sourceName !== "." &&
                        sourceName !== ".." &&
                        !arraySome(argv, value => value === "-T" || value === "--no-target-directory")
                        ? targetPath(sourceName, output)
                        : output;
                    // --parents 改变了目录拼接规则；对其输出树保守核对祖先。
                    add(arrayIncludes(argv, "--parents") ? output : actual, "write", directorySource || arrayIncludes(argv, "--parents"));
                }
            }
            return;
        }
        if (name === "dd") {
            for (let index = 0; index < argv.length; index++) {
                if (stringStartsWith(argv[index], "of="))
                    add(stringSlice(argv[index], 3), "write");
                else if (stringStartsWith(argv[index], "if="))
                    add(stringSlice(argv[index], 3), "read");
            }
            return;
        }
        if (name === "sed") {
            let inplace = false, expressionSeen = false, optionLiteral = false;
            for (let index = 0; index < argv.length; index++) {
                const value = argv[index];
                if (!optionLiteral && value === "--") {
                    optionLiteral = true;
                    continue;
                }
                if (!optionLiteral && test(/^(?:-i|--in-place(?:$|=))/, value)) {
                    inplace = true;
                    continue;
                }
                if (!optionLiteral &&
                    (value === "-f" ||
                        value === "--file" ||
                        stringStartsWith(value, "--file=") ||
                        (stringStartsWith(value, "-f") && value.length > 2))) {
                    analysis.script = true;
                    const file = value === "-f" || value === "--file"
                        ? argv[++index]
                        : stringStartsWith(value, "--file=")
                            ? stringSlice(value, 7)
                            : stringSlice(value, 2);
                    if (file)
                        add(file, "read");
                    expressionSeen = true;
                    continue;
                }
                if (!optionLiteral &&
                    (value === "-e" ||
                        value === "--expression" ||
                        stringStartsWith(value, "--expression=") ||
                        (stringStartsWith(value, "-e") && value.length > 2))) {
                    const expression = value === "-e" || value === "--expression"
                        ? argv[++index]
                        : stringStartsWith(value, "--expression=")
                            ? stringSlice(value, 13)
                            : stringSlice(value, 2);
                    if (expression)
                        inspectSed(expression);
                    expressionSeen = true;
                    continue;
                }
                if (!optionLiteral && stringStartsWith(value, "-"))
                    continue;
                if (!expressionSeen) {
                    inspectSed(value);
                    expressionSeen = true;
                }
                else
                    add(value, inplace ? "write" : "read");
            }
            return;
        }
        if (name === "git") {
            const working = arraySlice(directories);
            const repositories = [], outputs = [], worktrees = [], configuredWorktrees = [];
            let command = "";
            const configuration = (value) => {
                const equals = stringIndexOf(value, "=");
                if (equals < 0)
                    return;
                const key = stringLower(stringSlice(value, 0, equals));
                if (key === "core.worktree")
                    arrayPush(configuredWorktrees, stringSlice(value, equals + 1));
                // 这些设置会调用外部程序或执行 Shell；普通格式/颜色等配置不改变分类。
                if (test(/^(?:core\.(?:sshcommand|editor|pager|askpass|hookspath)|sequence\.editor|credential(?:\.[^.]+)?\.helper|diff\.(?:external|[^.]+\.(?:command|textconv))|merge\.[^.]+\.driver|filter\.[^.]+\.(?:clean|smudge|process)|gpg(?:\.[^.]+)?\.program)$/, key) ||
                    (stringStartsWith(key, "alias.") && stringStartsWith(stringSlice(value, equals + 1), "!")))
                    analysis.script = true;
            };
            for (let index = 0; index < argv.length; index++) {
                const value = argv[index];
                if (value === "-C" && argv[index + 1]) {
                    const next = argv[++index];
                    for (let at = 0; at < working.length; at++)
                        working[at] = targetPath(next, working[at]) ?? working[at];
                }
                else if (value === "--git-dir" || stringStartsWith(value, "--git-dir=")) {
                    const target = value === "--git-dir" ? argv[++index] : stringSlice(value, 10);
                    if (typeof target === "string")
                        for (let at = 0; at < working.length; at++) {
                            const resolved = targetPath(target, working[at]);
                            if (resolved)
                                arrayPush(repositories, resolved);
                        }
                }
                else if (value === "--work-tree" || stringStartsWith(value, "--work-tree=")) {
                    const target = value === "--work-tree" ? argv[++index] : stringSlice(value, 12);
                    if (typeof target === "string")
                        arrayPush(worktrees, target);
                }
                else if (command === "config" &&
                    (value === "--file" || value === "-f" || stringStartsWith(value, "--file="))) {
                    const target = value === "--file" || value === "-f" ? argv[++index] : stringSlice(value, 7);
                    if (typeof target === "string")
                        arrayPush(outputs, target);
                }
                else if ((value === "--output" || value === "-o") && argv[index + 1])
                    arrayPush(outputs, argv[++index]);
                else if (stringStartsWith(value, "--output="))
                    arrayPush(outputs, stringSlice(value, 9));
                else if (stringStartsWith(value, "-o") && value.length > 2)
                    arrayPush(outputs, stringSlice(value, 2));
                else if (value === "-c" && argv[index + 1])
                    configuration(argv[++index]);
                else if (stringStartsWith(value, "-c") && value.length > 2)
                    configuration(stringSlice(value, 2));
                else if (!command && !stringStartsWith(value, "-"))
                    command = value;
            }
            const readOnly = arrayIncludes([
                "log",
                "show",
                "diff",
                "rev-parse",
                "ls-files",
                "ls-tree",
                "cat-file",
                "describe",
                "version",
                "help",
            ], command) || informational(argv);
            const env = snapshotEnvironment(launchEnvironment);
            const environmentValue = (name) => {
                const keys = objectKeys(env);
                for (let index = 0; index < keys.length; index++)
                    if ((windows ? stringLower(keys[index]) === stringLower(name) : keys[index] === name) &&
                        typeof env[keys[index]] === "string")
                        return env[keys[index]];
                return undefined;
            };
            const repository = environmentValue("GIT_DIR");
            if (repository && !repositories.length)
                for (let index = 0; index < working.length; index++) {
                    const target = targetPath(repository, working[index]);
                    if (target)
                        arrayPush(repositories, target);
                }
            const worktree = environmentValue("GIT_WORK_TREE");
            if (worktree)
                arrayPush(worktrees, worktree);
            for (let index = 0; index < worktrees.length; index++)
                for (let at = 0; at < working.length; at++) {
                    const target = targetPath(worktrees[index], working[at]);
                    if (target)
                        add(target, readOnly ? "read" : "write", !readOnly);
                }
            for (let index = 0; index < configuredWorktrees.length; index++) {
                const value = configuredWorktrees[index];
                if (!isAbsolute(value) && !repositories.length) {
                    analysis.limited = true;
                    continue;
                }
                const bases = repositories.length ? repositories : working;
                for (let at = 0; at < bases.length; at++) {
                    const target = targetPath(value, bases[at]);
                    if (target)
                        add(target, readOnly ? "read" : "write", !readOnly);
                }
            }
            const environmentPaths = [
                "GIT_INDEX_FILE",
                "GIT_CONFIG",
                "GIT_CONFIG_GLOBAL",
                "GIT_CONFIG_SYSTEM",
            ];
            for (let index = 0; index < environmentPaths.length; index++) {
                const value = environmentValue(environmentPaths[index]);
                if (value)
                    for (let index = 0; index < working.length; index++) {
                        const target = targetPath(value, working[index]);
                        if (target)
                            add(target, readOnly ? "read" : "write");
                    }
            }
            const targets = repositories.length ? repositories : working;
            for (let index = 0; index < targets.length; index++)
                add(targets[index], readOnly ? "read" : "write", !readOnly);
            for (let index = 0; index < outputs.length; index++)
                for (let at = 0; at < working.length; at++) {
                    const output = targetPath(outputs[index], working[at]);
                    if (output)
                        add(output, "write");
                }
            return;
        }
        if (arrayIncludes([
            "cat",
            "type",
            "head",
            "tail",
            "less",
            "more",
            "wc",
            "stat",
            "ls",
            "dir",
            "readlink",
            "realpath",
            "sha256sum",
            "md5sum",
            "cmp",
            "diff",
            "grep",
            "rg",
            "findstr",
        ], name)) {
            for (let index = 0; index < operands.length; index++)
                add(operands[index], "read");
            return;
        }
        if (arrayIncludes(["curl", "wget", "ffmpeg", "ffprobe", "convert", "magick", "gm"], name)) {
            for (let index = 0; index < argv.length; index++) {
                const value = argv[index];
                if (arrayIncludes(["-o", "--output", "-O", "--output-document"], value) && argv[index + 1])
                    add(argv[++index], "write");
                else if ((name === "curl" && stringStartsWith(value, "-o") && value.length > 2) ||
                    (name === "wget" && stringStartsWith(value, "-O") && value.length > 2))
                    add(stringSlice(value, 2), "write");
                else if ((value === "-i" || value === "--upload-file" || value === "-T") && argv[index + 1])
                    add(argv[++index], "read");
                else if (stringStartsWith(value, "--output="))
                    add(stringSlice(value, 9), "write");
                else if (stringStartsWith(value, "--output-document="))
                    add(stringSlice(value, 18), "write");
                else if (arrayIncludes(["convert", "magick", "gm"], name) && !stringStartsWith(value, "-"))
                    add(value, index === argv.length - 1 ? "write" : "read");
                else if (!stringStartsWith(value, "-") &&
                    (looksLikePath(value) || name === "ffmpeg" || name === "ffprobe"))
                    add(value, name === "ffprobe" ? "read" : "write");
            }
            return;
        }
        // 未知原生工具只对明确出现的路径保守检查，不把消息或普通文本当作写目标。
        add(".", "write");
        for (let index = 0; index < argv.length; index++) {
            const value = argv[index];
            if (looksLikePath(value))
                add(value, "write");
            const equals = stringIndexOf(value, "=");
            if (equals > 0 && looksLikePath(stringSlice(value, equals + 1)))
                add(stringSlice(value, equals + 1), "write");
        }
    };
    const inspectSed = (expression) => {
        const commands = /(?:^|[;\n{])\s*(?:(?:\d+|\$|\/(?:\\.|[^/\\])*\/)(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/))?\s*!?\s*)?([rRwWe])(?:\s*([^;\n}]+)|$)/g;
        let direct;
        while ((direct = match(commands, expression))) {
            if (direct[1] === "e") {
                analysis.script = true;
                analysis.limited = true; // e 可执行输入构造的命令，不尝试求值。
            }
            else if (direct[2])
                add(trimmed(direct[2]), stringLower(direct[1]) === "w" ? "write" : "read");
        }
        const substitutions = /(?:^|[;\n{])\s*(?:(?:\d+|\$|\/(?:\\.|[^/\\])*\/)(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^/\\])*\/))?\s*!?\s*)?s([^\r\n\\])/g;
        let substitution;
        while ((substitution = match(substitutions, expression))) {
            const delimiter = substitution[1];
            let cursor = substitution.index + substitution[0].length;
            let parts = 0;
            while (cursor < expression.length && parts < 2) {
                const char = expression[cursor++];
                if (char === "\\" && cursor < expression.length)
                    cursor++;
                else if (char === delimiter)
                    parts++;
            }
            if (parts < 2)
                continue;
            while (cursor < expression.length && test(/[0-9gIpPmMiIe]/, expression[cursor])) {
                if (expression[cursor] === "e") {
                    analysis.script = true;
                    analysis.limited = true;
                }
                cursor++;
            }
            if (expression[cursor] === "w") {
                const start = ++cursor;
                while (cursor < expression.length && !test(/[;\n}]/, expression[cursor]))
                    cursor++;
                add(trimmed(stringSlice(expression, start, cursor)), "write");
            }
        }
    };
    const inspectShell = (command, depth = 0, syntax = currentSyntax, env = environment) => {
        if (depth > 12) {
            analysis.limited = true;
            return;
        }
        const parsed = tokens(command, syntax);
        if (parsed.limited)
            analysis.limited = true;
        shellDepth++;
        const previousSyntax = currentSyntax;
        currentSyntax = syntax;
        try {
            let words = [];
            for (let index = 0; index < parsed.values.length; index++) {
                const token = parsed.values[index];
                if (!token.operator) {
                    arrayPush(words, token.value);
                    continue;
                }
                if (test(/^[<>]/, token.value)) {
                    const next = parsed.values[++index];
                    if (next &&
                        !next.operator &&
                        !(test(/&$/, token.value) && (test(/^\d+-?$/, next.value) || next.value === "-")))
                        add(next.value, stringStartsWith(token.value, "<") ? "read" : "write");
                    continue;
                }
                inspect(words, depth, env);
                words = [];
            }
            inspect(words, depth, env);
        }
        finally {
            shellDepth--;
            currentSyntax = previousSyntax;
        }
    };
    if (typeof requestedShell === "string") {
        if (!isImplicitSystemShell(options, requestedShell))
            analysis.script = true;
        if (looksLikePath(requestedShell))
            add(requestedShell, "read");
        for (let index = 0; index < directories.length; index++) {
            const resolved = resolveCommandExecutable(requestedShell, directories[index], environment);
            if (resolved.path)
                add(resolved.path, "read");
            if (resolved.limited)
                analysis.limited = true;
        }
    }
    if (shell && typeof input[0] === "string") {
        let command = input[0];
        if (array)
            for (let index = 0; index < array.length; index++) {
                if (typeof array[index] !== "string")
                    return analysis;
                command += ` ${array[index]}`;
            }
        inspectShell(command);
    }
    else if (entry) {
        const words = [entry];
        total = entry.length;
        if (total > maxText) {
            analysis.limited = true;
            return analysis;
        }
        if (array)
            for (let index = 0; index < array.length; index++) {
                const value = array[index];
                if (typeof value !== "string")
                    return analysis;
                total += value.length;
                if (total > maxText || index >= maxTokens) {
                    analysis.limited = true;
                    return analysis;
                }
                arrayPush(words, value);
            }
        inspect(words);
    }
    return analysis;
}
//# sourceMappingURL=command-analysis.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "./objects.js"
__guardRegisterExports("protect/command-analysis.ts", { analyzeCommand })
