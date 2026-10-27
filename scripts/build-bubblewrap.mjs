import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../native/bubblewrap/", import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const pinned = {
  "bubblewrap-0.12.0.tar.xz": "9760d007363e3abba7c747489910f9f82d9fca53ba3bd3282e396fa3c97a3314",
  "libcap-2.78.tar.xz": "0d621e562fd932ccf67b9660fb018e468a683d7b827541df27813228c996bb11",
  "libcap-static-2.78-r0.apk": "6f783bc8fe44b635a58d97d58cd736e0fb840c121d156c9cf7ec3decbdf62297",
  "libcap-dev-2.78-r0.apk": "b9dd5ca2a572aa94fed4d3678101ea78a1d915fa9de045d7cc74dffb7bdcb6e5",
}
for (const [file, expected] of Object.entries(pinned))
  if (hash(path.join(root, "sources", file)) !== expected)
    throw new Error("Dependency source mismatch: " + file)
const args = process.argv.slice(2)
if (args.length && (args.length !== 3 || args[0] !== "--build"))
  throw new Error("Usage: node scripts/build-bubblewrap.mjs [--build <fresh-directory> <zig>]")
const target = path.join(root, "bin/linux-x64/bwrap")
if (args.length) {
  const build = path.resolve(args[1])
  const allowed = fileURLToPath(new URL("../tests/runs/", import.meta.url))
  if (!build.startsWith(allowed) || fs.existsSync(build))
    throw new Error("Build directory must be a fresh directory in tests/runs")
  const zig = path.resolve(args[2])
  const version = spawnSync(zig, ["version"], { encoding: "utf8", timeout: 5000 })
  if (version.status !== 0 || version.stdout.trim() !== "0.16.0")
    throw new Error("Zig 0.16.0 required")
  fs.mkdirSync(build)
  const run = (command, args) => {
    const result = spawnSync(command, args, {
      cwd: build,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120000,
    })
    if (result.error || result.status !== 0)
      throw new Error(`${command}: ${result.error ?? ""}${result.stdout}${result.stderr}`)
  }
  const cNames = [
    "bubblewrap.c",
    "bind-mount.c",
    "network.c",
    "utils.c",
    "chroot_realpath.c",
    "safe_openat.c",
  ]
  const headers = ["bind-mount.h", "network.h", "utils.h"]
  run("tar", [
    "-xf",
    path.join(root, "sources/bubblewrap-0.12.0.tar.xz"),
    ...[...cNames, ...headers].map(name => "bubblewrap-0.12.0/" + name),
  ])
  run("tar", ["-xf", path.join(root, "sources/libcap-static-2.78-r0.apk"), "usr/lib/libcap.a"])
  run("tar", [
    "-xf",
    path.join(root, "sources/libcap-dev-2.78-r0.apk"),
    "usr/include/sys/capability.h",
  ])
  const source = path.join(build, "bubblewrap-0.12.0")
  fs.writeFileSync(path.join(source, "config.h"), '#define PACKAGE_STRING "bubblewrap 0.12.0"\n')
  const output = path.join(build, "bwrap")
  run(zig, [
    "cc",
    "-target",
    "x86_64-linux-musl",
    "-O2",
    "-static",
    "-D_GNU_SOURCE",
    "-include",
    "linux/limits.h",
    "-I",
    source,
    "-I",
    path.join(build, "usr/include"),
    ...cNames.map(name => path.join(source, name)),
    path.join(build, "usr/lib/libcap.a"),
    "-o",
    output,
  ])
  fs.copyFileSync(output, target)
  manifest.sha256 = hash(target)
  manifest.bytes = fs.statSync(target).size
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
}
const bytes = fs.readFileSync(target)
const offset = Number(bytes.readBigUInt64LE(32)),
  size = bytes.readUInt16LE(54),
  count = bytes.readUInt16LE(56)
if (
  bytes.toString("hex", 0, 4) !== "7f454c46" ||
  bytes[4] !== 2 ||
  bytes.readUInt16LE(18) !== 62 ||
  Array.from({ length: count }, (_, index) => bytes.readUInt32LE(offset + size * index)).includes(3)
)
  throw new Error("Bundled bubblewrap must be a static x64 ELF executable")
if (
  manifest.sha256 !== hash(target) ||
  manifest.bytes !== bytes.length ||
  manifest.noticeSha256 !== hash(path.join(root, "NOTICE.txt"))
)
  throw new Error("Bundled bubblewrap hash mismatch")
console.log(
  JSON.stringify({
    mode: args.length ? "build" : "verify-prebuilt",
    sha256: manifest.sha256,
    bytes: bytes.length,
  }),
)
