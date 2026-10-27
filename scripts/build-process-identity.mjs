import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceRoot = path.join(root, "native", "process-identity")
const sourceNames = [
  "WindowsIdentity.cs",
  "linux_identity.c",
  "native_json.h",
  "native_sha256.h",
  "protocol.md",
  "NOTICE.txt",
]
const zigSha256 = "086ce9d47ba42f33a514e1a6e04eb1d4a8fa1d75e0868e0213caad447c91e864"
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const args = process.argv.slice(2)
const options = { build: false, target: "all" }
for (let at = 0; at < args.length; at++) {
  const arg = args[at]
  if (arg === "--build" && !options.build) options.build = true
  else if (
    ["--output", "--verify-root", "--zig", "--csc", "--target"].includes(arg) &&
    args[at + 1] &&
    !args[at + 1].startsWith("--")
  ) {
    const key = arg.slice(2).replace(/-([a-z])/g, (_, value) => value.toUpperCase())
    if (Object.hasOwn(options, key) && key !== "target") throw new Error(`Duplicate option ${arg}`)
    options[key] = args[++at]
  } else throw new Error(`Unsupported argument ${arg}`)
}
if (!["all", "win32-x64", "linux-x64"].includes(options.target))
  throw new Error("Unsupported target")
function ordinary(file) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Expected ordinary file: ${file}`)
  return st
}
function verify(directory) {
  const bundle = fs.realpathSync(directory)
  const resolve = name => {
    if (
      typeof name !== "string" ||
      path.isAbsolute(name) ||
      name.split(/[\\/]/).some(part => !part || part === "." || part === "..")
    )
      throw new Error("Invalid bundle route")
    let cursor = bundle
    for (const part of name.split(/[\\/]/)) {
      cursor = path.join(cursor, part)
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("Linked bundle route")
    }
    ordinary(cursor)
    return cursor
  }
  const manifest = JSON.parse(fs.readFileSync(resolve("manifest.json"), "utf8"))
  if (
    manifest.schemaVersion !== 1 ||
    manifest.protocol !== 1 ||
    manifest.profileSet !== "node24.22.1-v1" ||
    !Array.isArray(manifest.artifacts) ||
    !Array.isArray(manifest.builds) ||
    !manifest.sources ||
    sourceNames.some(name => !Object.hasOwn(manifest.sources, name))
  )
    throw new Error("Invalid native manifest")
  for (const [name, expected] of Object.entries(manifest.sources))
    if (!/^[a-f0-9]{64}$/.test(expected) || hash(resolve(name)) !== expected)
      throw new Error(`Source mismatch: ${name}`)
  const targets = new Set()
  for (const item of manifest.artifacts) {
    const target = `${item.platform}-${item.architecture}`
    if (
      !["win32-x64", "linux-x64"].includes(target) ||
      targets.has(target) ||
      item.file !== `bin/${target}/process-identity${item.platform === "win32" ? ".exe" : ""}` ||
      item.format !== (item.platform === "win32" ? "pe-framework" : "elf-static")
    )
      throw new Error("Invalid native artifact")
    const file = resolve(item.file)
    if (ordinary(file).size !== item.bytes || hash(file) !== item.sha256)
      throw new Error(`Artifact mismatch: ${target}`)
    if (process.platform === "linux" && item.platform === "linux")
      fs.accessSync(file, fs.constants.X_OK)
    targets.add(target)
  }
  if (
    (options.target === "all" && targets.size !== 2) ||
    (options.target !== "all" && !targets.has(options.target))
  )
    throw new Error("Missing native artifact")
  return { manifestSha256: hash(resolve("manifest.json")), artifacts: manifest.artifacts }
}
function run(executable, commandArgs, name, output, env = process.env) {
  const started = Date.now()
  const result = spawnSync(executable, commandArgs, {
    cwd: output,
    windowsHide: true,
    env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  })
  fs.writeFileSync(path.join(output, `${name}.stdout.txt`), result.stdout ?? "")
  fs.writeFileSync(path.join(output, `${name}.stderr.txt`), result.stderr ?? "")
  const receipt = {
    executable,
    executableSha256: hash(executable),
    args: commandArgs,
    nativeExitCode: result.status,
    nativeSignal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    elapsedMs: Date.now() - started,
  }
  fs.writeFileSync(
    path.join(output, `${name}.receipt.json`),
    JSON.stringify(receipt, null, 2) + "\n",
  )
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error(`${name} failed; retained receipt`)
  return receipt
}
// 分发清单使用相对标记，完整工具路径仅保留在本地构建回执。
function publicReceipt(receipt, output) {
  return {
    ...receipt,
    executable: path.basename(receipt.executable),
    args: receipt.args.map(value =>
      value.replaceAll(output, "<build>").replaceAll(root, "<repository>").replaceAll("\\", "/"),
    ),
  }
}
if (!options.build) {
  if (options.output || options.zig || options.csc)
    throw new Error("Compiler/output options require explicit --build")
  process.stdout.write(
    JSON.stringify(
      { mode: "verify-prebuilt", ...verify(options.verifyRoot ?? sourceRoot) },
      null,
      2,
    ) + "\n",
  )
} else {
  if (!options.output || options.verifyRoot)
    throw new Error("Build requires --output <fresh ignored directory>")
  const output = path.resolve(options.output)
  const allowed = path.join(root, "tests", "runs") + path.sep
  if (!output.startsWith(allowed) || fs.existsSync(output))
    throw new Error("Build output must be a new tests/runs directory")
  fs.mkdirSync(output, { recursive: true })
  if (
    !fs
      .realpathSync(output)
      .startsWith(fs.realpathSync(path.join(root, "tests", "runs")) + path.sep)
  )
    throw new Error("Build output escapes ignored staging")
  const bundle = path.join(output, "bundle")
  fs.mkdirSync(bundle)
  const sources = {}
  for (const name of sourceNames) {
    const file = path.join(sourceRoot, name)
    ordinary(file)
    fs.copyFileSync(file, path.join(bundle, name))
    sources[name] = hash(file)
  }
  const builds = [],
    artifacts = []
  const add = (platform, file, format, receipt) => {
    const item = {
      platform,
      architecture: "x64",
      file: path.relative(bundle, file).split(path.sep).join("/"),
      sha256: hash(file),
      bytes: ordinary(file).size,
      format,
    }
    builds.push({
      ...publicReceipt(receipt, output),
      sourceSha256: sources,
      output: item.file,
      outputSha256: item.sha256,
    })
    artifacts.push(item)
  }
  if (options.target !== "linux-x64") {
    const csc = path.resolve(
      options.csc ??
        path.join(
          process.env.WINDIR ?? "C:/Windows",
          "Microsoft.NET",
          "Framework64",
          "v4.0.30319",
          "csc.exe",
        ),
    )
    ordinary(csc)
    const directory = path.join(bundle, "bin", "win32-x64")
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, "process-identity.exe")
    const receipt = run(
      csc,
      [
        "/nologo",
        "/optimize+",
        "/platform:x64",
        "/target:exe",
        "/r:System.Management.dll",
        "/r:System.Web.Extensions.dll",
        `/out:${file}`,
        path.join(bundle, "WindowsIdentity.cs"),
      ],
      "csc",
      output,
    )
    add("win32", file, "pe-framework", receipt)
  }
  if (options.target !== "win32-x64") {
    const zig = path.resolve(
      options.zig ??
        path.join(
          process.env.LOCALAPPDATA ?? "",
          "Microsoft/WinGet/Packages/zig.zig_Microsoft.Winget.Source_8wekyb3d8bbwe/zig-x86_64-windows-0.16.0/zig.exe",
        ),
    )
    ordinary(zig)
    if (hash(zig) !== zigSha256) throw new Error("Zig toolchain hash mismatch")
    const version = run(zig, ["version"], "zig-version", output)
    if (fs.readFileSync(path.join(output, "zig-version.stdout.txt"), "utf8").trim() !== "0.16.0")
      throw new Error("Zig version mismatch")
    const directory = path.join(bundle, "bin", "linux-x64")
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, "process-identity")
    const env = {
      ...process.env,
      ZIG_GLOBAL_CACHE_DIR: path.join(output, "zig-global-cache"),
      ZIG_LOCAL_CACHE_DIR: path.join(output, "zig-local-cache"),
    }
    const receipt = run(
      zig,
      [
        "cc",
        "-target",
        "x86_64-linux-musl",
        "-std=c11",
        "-O2",
        "-static",
        "-Werror",
        "-Wall",
        "-Wextra",
        "-Wno-unused-function",
        path.join(bundle, "linux_identity.c"),
        "-o",
        file,
      ],
      "zig-linux",
      output,
      env,
    )
    const bytes = fs.readFileSync(file)
    if (
      !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      bytes.readUInt16LE(18) !== 62
    )
      throw new Error("Unexpected ELF target")
    const phoff = Number(bytes.readBigUInt64LE(32)),
      size = bytes.readUInt16LE(54),
      count = bytes.readUInt16LE(56)
    for (let i = 0; i < count; i++)
      if (bytes.readUInt32LE(phoff + i * size) === 3)
        throw new Error("ELF must not require an interpreter")
    add("linux", file, "elf-static", {
      ...receipt,
      compilerVersion: "0.16.0",
      versionReceiptSha256: hash(path.join(output, "zig-version.receipt.json")),
      versionExit: version.nativeExitCode,
    })
  }
  for (const name of sourceNames)
    if (hash(path.join(sourceRoot, name)) !== sources[name])
      throw new Error(`Source changed while building: ${name}`)
  fs.writeFileSync(
    path.join(bundle, "manifest.json"),
    JSON.stringify(
      { schemaVersion: 1, protocol: 1, profileSet: "node24.22.1-v1", sources, artifacts, builds },
      null,
      2,
    ) + "\n",
  )
  process.stdout.write(
    JSON.stringify({ mode: "maintainer-explicit-build", output, ...verify(bundle) }, null, 2) +
      "\n",
  )
}
