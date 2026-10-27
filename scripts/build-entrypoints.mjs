import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
const dist = path.join(root, "dist")
const oldSources = [
  "audit-buffer.ts",
  "audit-coverage.ts",
  "audit-event.ts",
  "audit-protocol.ts",
  "audit-receiver.ts",
  "audit-redaction.ts",
  "audit-sender.ts",
  "audit-sink.ts",
  "bootstrap-exit-plan.ts",
  "bootstrap-exit-watch.ts",
  "bootstrap-handoff.ts",
  "bootstrap-ready.ts",
  "bootstrap-shutdown.ts",
  "child-preload.ts",
  "cli.ts",
  "common.ts",
  "config.ts",
  "control.ts",
  "core-loader-source.ts",
  "entry.ts",
  "host-event-policy.ts",
  "identity.ts",
  "instrumentation.ts",
  "integrity.ts",
  "launcher.ts",
  "module-audit.ts",
  "module-exports.ts",
  "module-source.ts",
  "monitor-report.ts",
  "native-process-identity.ts",
  "node-launch.ts",
  "platform.ts",
  "plugin-monitor.ts",
  "plugin.ts",
  "pm2-attach-lock.ts",
  "pm2-auto.ts",
  "pm2-bootstrap-exit.ts",
  "pm2-compat-v2.ts",
  "pm2-compat.ts",
  "pm2-daemon.ts",
  "pm2-inspector.ts",
  "pm2-preload.cts",
  "pm2-versions.ts",
  "policy.ts",
  "private-windows-runtime.ts",
  "project-lock.ts",
  "runtime-bootstrap.cts",
  "runtime-broker.ts",
  "runtime-bus.ts",
  "runtime-policy.ts",
  "runtime.ts",
  "shared/common.ts",
  "sandbox-linux-identity.ts",
  "sandbox-linux.ts",
  "sandbox-resolution.ts",
  "sandbox-windows.ts",
  "sandbox-windows/diagnostics.ts",
  "sandbox-windows/transport.ts",
  "supervisor.ts",
  "types.ts",
  "worker-monitor.ts",
  "worker-preload.ts",
  "worker-transport.ts",
]
const entrypoints = {
  "cli.js": {
    target: "./cli/index.js",
    kind: "import",
  },
  "entry.js": {
    target: "./entry/preload.js",
    kind: "import",
  },
  "launcher.js": {
    target: "./entry/launcher.js",
    kind: "import",
  },
  "pm2-preload.cjs": {
    target: "./pm2/preload.cjs",
    kind: "require",
  },
  "runtime-bootstrap.cjs": {
    target: "./runtime/bootstrap.cjs",
    kind: "require",
  },
  "child-preload.js": {
    target: "./runtime/child-preload.js",
    kind: "import",
  },
  "worker-preload.js": {
    target: "./runtime/worker-preload.js",
    kind: "import",
  },
  "pm2-compat.js": {
    target: "./pm2/compat.js",
    kind: "export",
  },
  "pm2-compat-v2.js": {
    target: "./pm2/compat-v2.js",
    kind: "export",
  },
  "pm2-daemon.js": {
    target: "./pm2/daemon.js",
    kind: "export",
  },
  "bootstrap-exit-watch.js": {
    target: "./host/bootstrap/exit-watch.js",
    kind: "export",
  },
}

// 只处理本次目录迁移留下的明确产物。
const oldOutputs = oldSources.flatMap(source => {
  const commonjs = source.endsWith(".cts")
  const stem = source.replace(/\.cts$|\.ts$/, "")
  const extension = commonjs ? ".cjs" : ".js"
  return [stem + extension, stem + extension + ".map", stem + (commonjs ? ".d.cts" : ".d.ts")]
})

function guardedPath(relative) {
  const absolute = path.resolve(dist, relative)
  if (!absolute.startsWith(dist + path.sep)) throw new Error("Build output escapes dist")
  let current = dist
  for (const part of ["", ...path.relative(dist, absolute).split(path.sep)]) {
    if (part) current = path.join(current, part)
    let info
    try {
      info = fs.lstatSync(current)
    } catch (error) {
      if (error.code === "ENOENT") return absolute
      throw error
    }
    if (info.isSymbolicLink()) throw new Error("Refusing linked build output: " + current)
    if (current !== absolute && !info.isDirectory())
      throw new Error("Build output ancestor is not a directory: " + current)
    if (current === absolute && !info.isFile())
      throw new Error("Build output is not an ordinary file: " + current)
  }
  return absolute
}

const declarations = name => name.replace(/\.cjs$/, ".d.cts").replace(/\.js$/, ".d.ts")
const outputs = [
  ...oldOutputs,
  ...Object.keys(entrypoints).flatMap(name => [name, declarations(name)]),
]
const distInfo = fs.lstatSync(dist)
if (distInfo.isSymbolicLink() || !distInfo.isDirectory())
  throw new Error("Refusing linked or invalid dist directory")
// 先检查全部路径，再执行删除，避免越界或误跟随链接。
for (const name of outputs) guardedPath(name)
for (const entry of Object.values(entrypoints)) {
  const target = guardedPath(entry.target)
  if (!fs.statSync(target).isFile()) throw new Error("Missing compiled entrypoint: " + target)
}
for (const name of oldOutputs) {
  const target = guardedPath(name)
  try {
    fs.unlinkSync(target)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
}
for (const [name, entry] of Object.entries(entrypoints)) {
  const target = JSON.stringify(entry.target)
  const source =
    entry.kind === "require"
      ? "require(" + target + ")\n"
      : entry.kind === "export"
        ? "export * from " + target + "\n"
        : "import " + target + "\n"
  fs.writeFileSync(guardedPath(name), source, "utf8")
  fs.writeFileSync(
    guardedPath(declarations(name)),
    entry.kind === "require" ? "export {}\n" : source,
    "utf8",
  )
}
console.log("已生成 " + Object.keys(entrypoints).length + " 个兼容入口，并清理旧目录产物")
