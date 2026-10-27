import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../native/windows/", import.meta.url))
const names = [
  "GuardSandbox.cs",
  "GuardSharedLabels.cs",
  "GuardDeniedDirectories.cs",
  "CanonicalMetadata.cs",
]
const digest = createHash("sha256")
for (const name of names)
  digest
    .update(name)
    .update("\0")
    .update(fs.readFileSync(path.join(root, name)))
    .update("\0")
digest
  .update("PrepareBrokerCache.ps1\0")
  .update(fs.readFileSync(path.join(root, "PrepareBrokerCache.ps1")))
const sourceDigest = digest.digest("hex")
const file = "bin/win32-x64/GuardSandbox.exe"
const target = path.join(root, file)
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const args = process.argv.slice(2)
if (args.length > 1 || (args[0] !== undefined && args[0] !== "--build"))
  throw new Error("Usage: node scripts/build-windows-broker.mjs [--build]")
if (args[0] === "--build") {
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error("Windows x64 is required to rebuild the bundled broker")
  const compiler = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  )
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const result = spawnSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/reference:System.Web.Extensions.dll",
      `/out:${target}`,
      ...names.map(name => path.join(root, name)),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30000 },
  )
  if (result.error || result.status !== 0)
    throw new Error(
      `Windows broker compilation failed: ${result.error ?? ""}${result.stdout}${result.stderr}`,
    )
  fs.writeFileSync(
    path.join(root, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        platform: "win32",
        architecture: "x64",
        sourceDigest,
        file,
        bytes: fs.statSync(target).size,
        sha256: hash(target),
      },
      null,
      2,
    ) + "\n",
  )
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"))
if (
  manifest.schemaVersion !== 1 ||
  manifest.platform !== "win32" ||
  manifest.architecture !== "x64" ||
  manifest.file !== file ||
  manifest.sourceDigest !== sourceDigest ||
  manifest.sha256 !== hash(target) ||
  manifest.bytes !== fs.statSync(target).size
)
  throw new Error("Bundled Windows broker is stale; rebuild with --build on Windows")
console.log(JSON.stringify({ mode: args[0] ? "build" : "verify-prebuilt", ...manifest }))
