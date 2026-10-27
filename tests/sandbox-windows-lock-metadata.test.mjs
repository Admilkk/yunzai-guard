import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { compileWindowsSandbox } from "../dist/sandbox/windows.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
test(
  "private ACL lock files reject aliases and altered metadata before modifying an external target",
  { skip: process.platform !== "win32", timeout: 30000 },
  () => {
    const root = fs.mkdtempSync(path.join(repository, "tests/runs/windows-lock-metadata-"))
    const privatePath = path.join(root, "private"),
      external = path.join(root, "external")
    const payload = Buffer.from(
      JSON.stringify({ root, privatePath, external, helper: compileWindowsSandbox() }),
    ).toString("base64")
    const script = String.raw`$ErrorActionPreference='Stop'
$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__INPUT__'))|ConvertFrom-Json
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($path in @($data.privatePath,$data.external)) {
  $acl=New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false)
  foreach($sid in @($owner,(New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'))) {$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)))}
  [IO.Directory]::CreateDirectory([string]$path,$acl)|Out-Null
}
$type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox')
$method=$type.GetMethod('SharedStoreLock',[Reflection.BindingFlags]'NonPublic,Static')
$ordinary=Join-Path $data.privatePath 'ordinary.lock'
$held=$method.Invoke($null,@([string]$ordinary));$held.Dispose()
$again=$method.Invoke($null,@([string]$ordinary));$again.Dispose()
@{ordinary=$ordinary;ordinaryAndRepeat=$true}|ConvertTo-Json -Compress
`.replace("__INPUT__", payload)
    const initial = JSON.parse(
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      }),
    )
    const sharedInput = { helper: compileWindowsSandbox(), root, privatePath, external }
    const inspect = filename => {
      const input = Buffer.from(JSON.stringify({ ...sharedInput, filename })).toString("base64")
      const probe = `$ErrorActionPreference='Stop';$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;$type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox');try{$held=$type.GetMethod('SharedStoreLock',[Reflection.BindingFlags]'NonPublic,Static').Invoke($null,@([string]$data.filename));$held.Dispose();@{accepted=$true}|ConvertTo-Json -Compress}catch{@{accepted=$false;error=$_.Exception.InnerException.Message}|ConvertTo-Json -Compress}`
      return JSON.parse(
        execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", probe], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 10000,
        }),
      )
    }
    const link = path.join(privatePath, "junction")
    fs.symlinkSync(external, link, "junction")
    const missingTarget = path.join(external, "must-not-create.lock")
    const junctionResult = inspect(path.join(link, "must-not-create.lock"))
    assert.equal(junctionResult.accepted, false)
    assert.match(junctionResult.error, /重解析点/)
    assert.equal(fs.existsSync(missingTarget), false)
    const hardlink = path.join(privatePath, "hardlink.lock")
    fs.linkSync(initial.ordinary, hardlink)
    const hardlinkResult = inspect(hardlink)
    assert.equal(hardlinkResult.accepted, false)
    assert.match(hardlinkResult.error, /one hard link/)
    const loose = path.join(root, "non-private.lock")
    fs.writeFileSync(loose, "unchanged")
    const looseResult = inspect(loose)
    assert.equal(looseResult.accepted, false)
    assert.match(looseResult.error, /owner-private/)
    assert.equal(fs.readFileSync(loose, "utf8"), "unchanged")
    let fileSymlink
    try {
      fs.symlinkSync(
        path.join(external, "missing-file-symlink-target"),
        path.join(privatePath, "file-symlink.lock"),
        "file",
      )
      fileSymlink = inspect(path.join(privatePath, "file-symlink.lock"))
      assert.equal(fileSymlink.accepted, false)
      assert.equal(fs.existsSync(path.join(external, "missing-file-symlink-target")), false)
    } catch (error) {
      if (error.code !== "EPERM") throw error
      fileSymlink = {
        skipped: true,
        reason: "Host file symlink creation requires a privilege unavailable to this test user",
      }
    }
    fs.writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify(
        {
          root,
          initial,
          junctionResult,
          hardlinkResult,
          looseResult,
          fileSymlink,
          status: "private-lock-alias-checks-passed",
        },
        null,
        2,
      ) + "\n",
    )
  },
)
