import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { analyzeCommand } from "../dist/protect/command-analysis.js"
import { snapshotLaunch } from "../dist/runtime/launch.js"
import { createCommandGuard } from "../dist/protect/commands.js"
import { parseSettings } from "../dist/config/index.js"
import { decodeShellCommand } from "../dist/protect/shell-text.js"

const encode = text => Buffer.from(text, "utf16le").toString("base64")
const root = path.resolve("tests/runs/rc-parser-fixture")
const protectedRoot = path.join(root, "guard")
const ps = text => `powershell -EncodedCommand ${encode(text)}`
const prelude =
  '$ProgressPreference="SilentlyContinue";[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;prompt;'
const posix = text => 'echo "[$USER@$HOSTNAME $PWD]$([ "$UID" = 0 ]&&echo "#"||echo "$") ";' + text
const bash = text => '"$0" -ic \'echo "${PS1@P}"\';' + text

test("编码检查不依赖业务可修改的 Buffer 编解码方法", () => {
  const text = "Write-Output 测试",
    encoded = encode(text),
    original = Buffer.from,
    originalString = Buffer.prototype.toString
  try {
    Buffer.from = () => {
      throw new Error("untrusted decoder")
    }
    Buffer.prototype.toString = () => "forged"
    assert.equal(decodeShellCommand(encoded), text)
  } finally {
    Buffer.from = original
    Buffer.prototype.toString = originalString
  }
})
function check(text, options = {}, audit = false) {
  const args = snapshotLaunch("exec", [text, { cwd: root, ...options }])
  const guard = createCommandGuard({
    roots: [protectedRoot],
    readRoots: [],
    settings: parseSettings(audit ? { rules: [{ id: "audit", action: "audit" }] } : {}),
    deny() {
      throw Object.assign(new Error("protected"), { code: "ERR_GUARD_SELF_PROTECTION" })
    },
    emit() {},
    originPlugin: () => "TRSS-Plugin",
  })
  guard("exec", args)
  return analyzeCommand("exec", args)
}

test("TRSS rc 普通提示符包装和编码正文按实际内容检查", () => {
  for (const text of ["echo ordinary", 'printf "ordinary"']) {
    assert.equal(
      check(posix(text), { shell: "/bin/sh", env: { PATH: "/usr/bin:/bin" } }).limited,
      undefined,
    )
    assert.equal(
      check(bash(text), { shell: "/bin/bash", env: { PATH: "/usr/bin:/bin" } }).script,
      false,
    )
  }
  assert.equal(
    check("echo '${literal:-$(not-executed)}'", {
      shell: "/bin/sh",
      env: { PATH: "/usr/bin:/bin" },
    }).limited,
    undefined,
  )
  assert.equal(check(ps(prelude + "Write-Output ordinary")).script, false)
  for (const flag of ["-e", "-en", "-enc", "-enco", "-encodedc", "-EC"])
    assert.equal(check(`powershell ${flag} ${encode("Write-Output ordinary")}`).script, false)
})

test("编码正文的写入、追加、删除与嵌套解释器不能取得业务白名单豁免", () => {
  const target = path.join(protectedRoot, "settings.yaml")
  for (const body of [
    `Remove-Item -Recurse -Force '${protectedRoot}'`,
    `Set-Content -LiteralPath '${target}' -Value changed`,
    `Add-Content '${target}' changed`,
    `echo changed > '${target}'`,
    `Remove-Item 'FileSystem::${target}'`,
    `Remove-Item -LiteralPath:'${target}'`,
    `Remove-Item 'ordinary','${target}'`,
    `Set-Content -Path:'${target}' -Value changed`,
    `cpi -Destination:'${protectedRoot}' -Path ordinary`,
    `Remove-Item '${protectedRoot.replace(/guard$/, "gu`u{61}rd")}'`,
    `Remove-Item -LiteralPath '${protectedRoot.replace(/guard$/, "gu`\nard")}'`,
    `powershell -NoProfile -EncodedCommand ${encode(`Remove-Item '${target}'`)}`,
  ])
    for (const audit of [false, true])
      assert.throws(
        () => check(ps(prelude + body), {}, audit),
        { code: "ERR_GUARD_SELF_PROTECTION" },
        body,
      )
  assert.throws(() => check(ps(prelude + 'node -e "1"')), { code: "GUARD_DENIED" })
  assert.throws(() => check(ps("Set-Alias echo Remove-Item;echo guard/settings.yaml")), {
    code: "ERR_GUARD_SELF_PROTECTION",
  })
  for (const body of [
    "powershell -NoProfile -UnknownOption body",
    "powershell -e invalid",
    "bash -ic 'rm guard/settings.yaml'",
    "Start-Process node",
    "[IO.File]::WriteAllText('guard/settings.yaml','x')",
  ])
    assert.throws(() => check(ps(body), {}, true), { code: "ERR_GUARD_SELF_PROTECTION" })
  for (const code of ["!invalid!", "YQ==", encode("echo ordinary") + "=", "A".repeat(140000)])
    assert.throws(() => check(`powershell -EncodedCommand ${code}`), {
      code: "ERR_GUARD_SELF_PROTECTION",
    })
})

test("POSIX 命令替换递归检查目标，动态写目标仍保守拒绝", () => {
  const options = { shell: "/bin/sh", env: { PATH: "/usr/bin:/bin" } }
  for (const text of [
    'echo "$(touch guard/settings.yaml)"',
    'echo "`touch guard/settings.yaml`"',
    'echo "$(echo "$(rm -rf guard)")"',
    "rm -rf gu\\\nard",
  ])
    assert.throws(() => check(text, options, true), { code: "ERR_GUARD_SELF_PROTECTION" })
  assert.throws(() => check('tee "$(echo guard/settings.yaml)"', options, true), {
    code: "ERR_GUARD_SELF_PROTECTION",
  })
  assert.throws(() => check(posix("node -e 1"), options), { code: "GUARD_DENIED" })
  for (const command of ["find . -delete", "find . -name guard -exec rm -rf {} +"])
    assert.throws(() => check(command, options, true), { code: "ERR_GUARD_SELF_PROTECTION" })
})

test("启动参数关闭隐藏的 Shell 启动脚本，缩写编码仍按正文解析", () => {
  const argv = snapshotLaunch("execFile", [
    "powershell.exe",
    ["-e", encode("echo hi")],
    { env: { PATH: "", BASH_ENV: "bad.sh", ENV: "bad.sh", "BASH_FUNC_echo%%": "bad" } },
  ])
  assert.equal(argv[1][0], "-NoProfile")
  assert.equal(argv[2].env.BASH_ENV, undefined)
  assert.equal(argv[2].env.ENV, undefined)
  assert.equal(argv[2].env["BASH_FUNC_echo%%"], undefined)
  const cmd = snapshotLaunch("spawn", ["cmd.exe", ["/c", "echo hi"], {}])
  assert.equal(cmd[1][0], "/d")
})

test(
  "Linux 实际 rc 输出可用，Bash 提示符不执行启动文件",
  { skip: process.platform !== "linux", timeout: 30000 },
  t => {
    const temporary = fs.realpathSync(os.tmpdir()),
      directory = fs.mkdtempSync(path.join(temporary, "guard-rc-posix-"))
    t.after(() => {
      const absolute = fs.realpathSync(directory)
      assert.equal(path.dirname(absolute), temporary)
      assert.ok(path.basename(absolute).startsWith("guard-rc-posix-"))
      fs.rmSync(absolute, { recursive: true, force: true })
    })
    const state = path.join(directory, "state"),
      sentinel = path.join(state, "sentinel.txt"),
      startup = path.join(directory, "startup.sh")
    fs.mkdirSync(state)
    fs.writeFileSync(sentinel, "unchanged")
    fs.writeFileSync(startup, `printf changed > '${sentinel}'\n`)
    const runtime = new URL("../dist/runtime/index.js", import.meta.url).href,
      config = new URL("../dist/config/index.js", import.meta.url).href
    const source = `
 import assert from 'node:assert/strict';import cp from 'node:child_process';
 import {installRuntime} from ${JSON.stringify(runtime)};import {parseSettings} from ${JSON.stringify(config)};
 installRuntime({settings:parseSettings({}),stateDir:${JSON.stringify(state)},identity:{id:'rc',kind:'yunzai',generation:1,pid:process.pid,originPlugin:'TRSS-Plugin',observability:'js-entrypoints'},emit(){}});
 const env={...process.env,BASH_ENV:${JSON.stringify(startup)}};
 assert.equal(cp.execSync(${JSON.stringify(posix("echo ordinary"))},{encoding:'utf8',env}).trim().endsWith('ordinary'),true);
 assert.equal(cp.execSync(${JSON.stringify(bash("echo bash-ok"))},{shell:'/bin/bash',encoding:'utf8',env}).trim(),'bash-ok');
 for(const command of [${JSON.stringify(posix(`rm -rf '${state}'`))},${JSON.stringify(bash(`echo changed > '${sentinel}'`))}])assert.throws(()=>cp.execSync(command,{shell:'/bin/bash',env}),{code:'ERR_GUARD_SELF_PROTECTION'});
 console.log('posix-rc-ok');`
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: directory,
      encoding: "utf8",
      timeout: 25000,
    })
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    assert.equal(result.stdout.trim(), "posix-rc-ok")
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged")
  },
)

test(
  "真实 rc 执行保留普通输出，编码 Guard 写入在执行前拒绝",
  { skip: process.platform !== "win32", timeout: 30000 },
  t => {
    const temporary = fs.realpathSync(os.tmpdir()),
      directory = fs.mkdtempSync(path.join(temporary, "guard-rc-"))
    t.after(() => {
      const absolute = fs.realpathSync(directory)
      assert.equal(path.dirname(absolute), temporary)
      assert.ok(path.basename(absolute).startsWith("guard-rc-"))
      fs.rmSync(absolute, { recursive: true, force: true })
    })
    const state = path.join(directory, "state"),
      sentinel = path.join(state, "sentinel.txt")
    fs.mkdirSync(state)
    fs.writeFileSync(sentinel, "unchanged")
    const runtime = new URL("../dist/runtime/index.js", import.meta.url).href,
      config = new URL("../dist/config/index.js", import.meta.url).href
    const source = `
 import assert from 'node:assert/strict';import cp from 'node:child_process';import {promisify} from 'node:util';
 import {installRuntime} from ${JSON.stringify(runtime)};import {parseSettings} from ${JSON.stringify(config)};
 installRuntime({settings:parseSettings({}),stateDir:${JSON.stringify(state)},identity:{id:'rc',kind:'yunzai',generation:1,pid:process.pid,originPlugin:'TRSS-Plugin',observability:'js-entrypoints'},emit(){}});
 const prelude=${JSON.stringify(prelude)};const encode=text=>Buffer.from(text,'utf16le').toString('base64');const command=text=>'powershell -EncodedCommand '+encode(prelude+text);
 assert.equal(cp.execSync(command('Write-Output ordinary'),{encoding:'utf8',timeout:10000}).trim().endsWith('ordinary'),true);
 assert.equal((await promisify(cp.exec)(command('Write-Output asynchronous'),{timeout:10000})).stdout.trim().endsWith('asynchronous'),true);
 for(const body of [${JSON.stringify(`Set-Content '${sentinel}' changed`)},${JSON.stringify(`Remove-Item -Recurse -Force '${state}'`)}])assert.throws(()=>cp.execSync(command(body)),{code:'ERR_GUARD_SELF_PROTECTION'});
 assert.throws(()=>cp.execSync(command('node -e 1')),{code:'GUARD_DENIED'});
 console.log('rc-ok');`
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 25000,
    })
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    assert.equal(result.stdout.trim(), "rc-ok")
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged")
  },
)
