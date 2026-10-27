import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { compileWindowsSandbox, spawnWindowsSandbox } from "../dist/sandbox/windows.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function security(helper, paths) {
  const payload = Buffer.from(JSON.stringify({ helper, paths })).toString("base64")
  const script = `$ErrorActionPreference='Stop';$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox');$method=$type.GetMethod('ReadLabel',[Reflection.BindingFlags]'NonPublic,Static');$result=@{};foreach($item in $data.paths.psobject.Properties){$name=[string]$item.Value;$acl=if([IO.Directory]::Exists($name)){[IO.Directory]::GetAccessControl($name)}else{[IO.File]::GetAccessControl($name)};$result[$item.Name]=@{dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);label=$method.Invoke($null,@($name))}};$result|ConvertTo-Json -Compress -Depth 5`
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    }),
  )
}

for (const scenario of [
  "unlisted-link",
  "changed-target",
  "not-a-junction",
  "forged-source",
  "forged-writable-file-target",
]) {
  test(
    `Windows dependency authorization rejects ${scenario} before changing target permissions`,
    { skip: process.platform !== "win32", timeout: 30000 },
    async t => {
      const runs = path.join(repository, "tests/runs")
      fs.mkdirSync(runs, { recursive: true })
      const base = fs.mkdtempSync(path.join(runs, "windows-link-auth-"))
      const root = path.join(base, "project"),
        outside = path.join(base, "outside")
      for (const directory of [
        outside,
        path.join(root, "plugins/demo/node_modules"),
        path.join(root, "vendor/dep"),
        path.join(root, "config/business"),
      ])
        fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}')
      fs.writeFileSync(path.join(root, "vendor/dep/index.js"), "module.exports='original'\n")
      fs.writeFileSync(path.join(root, "config/business/state.json"), "{}")
      fs.writeFileSync(path.join(outside, "original.txt"), "outside-original")
      const alias = path.join(root, "plugins/demo/node_modules/dep")
      fs.symlinkSync(path.join(root, "vendor/dep"), alias, "junction")
      if (scenario === "unlisted-link")
        fs.symlinkSync(
          path.join(root, "vendor/dep"),
          path.join(root, "plugins/demo/unapproved"),
          "junction",
        )
      const entry = path.join(root, "probe.cjs")
      fs.writeFileSync(entry, "setInterval(()=>{},1000)\n")
      const helper = compileWindowsSandbox()
      const paths = {
        root,
        outside,
        outsideFile: path.join(outside, "original.txt"),
        store: path.join(root, "vendor/dep"),
        storeFile: path.join(root, "vendor/dep/index.js"),
        exactFile: path.join(root, "config/business/state.json"),
      }
      const before = security(helper, paths)
      const writeFile = fs.writeFileSync
      let intercepted = false,
        child
      const errors = []
      let ready = false
      // 模拟受信采集与原生 helper 启动之间的宿主修改，范围仅限新建无害夹具及其清单。
      fs.writeFileSync = function (filename, data, ...rest) {
        if (typeof filename === "string" && path.basename(filename) === "readonly-links.json") {
          intercepted = true
          const manifest = JSON.parse(String(data))
          if (scenario === "forged-source") manifest.links[0].from = "plugins/demo/unlisted"
          if (scenario === "forged-writable-file-target") manifest.links[0].to = "config/business"
          const result = writeFile.call(this, filename, JSON.stringify(manifest), ...rest)
          if (scenario === "changed-target" || scenario === "not-a-junction") {
            fs.unlinkSync(alias)
            if (scenario === "changed-target") fs.symlinkSync(outside, alias, "junction")
            else fs.mkdirSync(alias)
          }
          return result
        }
        return writeFile.call(this, filename, data, ...rest)
      }
      try {
        child = spawnWindowsSandbox(
          root,
          {
            sandbox: {
              network: "none",
              writablePaths: ["plugins/demo"],
              writableFiles: ["config/business/state.json"],
            },
          },
          {
            executable: process.execPath,
            args: [entry],
            env: { ...process.env },
            forwardOutput: false,
          },
        )
      } finally {
        fs.writeFileSync = writeFile
      }
      child.on("error", error => errors.push(error.message))
      child.on("sandbox-ready", () => {
        ready = true
        void child.sandboxDispose().catch(() => {})
      })
      try {
        await child.sandboxCleanup
        assert.equal(intercepted, true)
        assert.equal(ready, false)
        const expected = {
          "unlisted-link": /unapproved reparse point/,
          "changed-target": /target changed after collection/,
          "not-a-junction": /Only approved directory junctions/,
          "forged-source": /overlaps writable, protected, or external/,
          "forged-writable-file-target": /overlaps writable, protected, or external/,
        }[scenario]
        assert.match(errors.join("\n"), expected)
        assert.deepEqual(security(helper, paths), before)
        assert.equal(fs.readFileSync(paths.outsideFile, "utf8"), "outside-original")
        assert.equal(fs.readFileSync(paths.storeFile, "utf8"), "module.exports='original'\n")
        assert.equal(fs.existsSync(child.sandboxSession), false)
        fs.writeFileSync(
          path.join(base, "report.json"),
          JSON.stringify(
            {
              scenario,
              status: "rejected-before-permission-changes",
              errors,
              ready,
              sessionRemoved: true,
              securityUnchanged: true,
            },
            null,
            2,
          ),
        )
        t.diagnostic(`Benign native link authorization evidence retained at ${base}`)
      } finally {
        await child.sandboxDispose()
      }
    },
  )
}
