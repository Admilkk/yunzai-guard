import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"
import test from "node:test"
import {
  cleanupWindowsSandbox,
  compileWindowsSandbox,
  spawnWindowsSandbox,
} from "../dist/sandbox/windows.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function inspect(helper, operation, input) {
  const payload = Buffer.from(JSON.stringify({ helper, operation, ...input })).toString("base64")
  const script = `$ErrorActionPreference='Stop';
    $data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;
    $type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox');
    $flags=[Reflection.BindingFlags]'NonPublic,Static';
    if($data.operation -eq 'snapshot') {
      $result=@{};
      foreach($item in $data.paths.psobject.Properties) {
        $target=[string]$item.Value;
        $acl=[IO.Directory]::GetAccessControl($target);
        $result[$item.Name]=@{dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);label=$type.GetMethod('ReadLabel',$flags).Invoke($null,@($target))};
      }
      $result|ConvertTo-Json -Compress -Depth 5;
    } elseif($data.operation -eq 'label') {
      $type.GetMethod('RestoreLabel',$flags).Invoke($null,@([string]$data.path,[string]$data.label));
      'null';
    } elseif($data.operation -eq 'low') {
      $type.GetMethod('LowLabel',$flags).Invoke($null,@([string]$data.path,[IntPtr]::Zero,$false));
      'null';
    } elseif($data.operation -eq 'equivalence') {
      $result=@();
      foreach($item in $data.cases) {
        $result+=@{name=$item.name;accepted=$type.GetMethod('IsEquivalentEmptyLabel',$flags).Invoke($null,@([string]$item.current,[string]$item.original))};
      }
      ConvertTo-Json -InputObject $result -Compress -Depth 4;
    } else {throw 'Unknown benign test operation'}
  `
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    }),
  )
}

test(
  "Windows empty-label equivalence rejects nonempty ACEs and incompatible protection flags",
  { skip: process.platform !== "win32", timeout: 30000 },
  () => {
    const helper = compileWindowsSandbox()
    const cases = [
      {
        name: "absent normalized to null",
        original: "",
        current: "S:PAINO_ACCESS_CONTROL",
        expected: true,
      },
      {
        name: "null auto inheritance",
        original: "S:NO_ACCESS_CONTROL",
        current: "S:AINO_ACCESS_CONTROL",
        expected: true,
      },
      {
        name: "empty canonical ACL",
        original: "S:AI",
        current: "S:AINO_ACCESS_CONTROL",
        expected: true,
      },
      {
        name: "protected empty remains protected",
        original: "S:PAI",
        current: "S:PAINO_ACCESS_CONTROL",
        expected: true,
      },
      { name: "low label", original: "", current: "S:(ML;OICI;NW;;;LW)", expected: false },
      {
        name: "external medium label",
        original: "",
        current: "S:(ML;OICI;NW;;;ME)",
        expected: false,
      },
      { name: "external audit ACE", original: "", current: "S:(AU;SA;FA;;;WD)", expected: false },
      { name: "external owner", original: "", current: "O:SYS:", expected: false },
      { name: "external DACL", original: "", current: "D:(A;;FA;;;WD)S:", expected: false },
      { name: "malformed descriptor", original: "", current: "invalid", expected: false },
      {
        name: "protected bit removed",
        original: "S:PNO_ACCESS_CONTROL",
        current: "S:AINO_ACCESS_CONTROL",
        expected: false,
      },
      {
        name: "new protection on nonnull empty ACL",
        original: "",
        current: "S:PAI",
        expected: false,
      },
      {
        name: "auto inheritance removed",
        original: "S:AINO_ACCESS_CONTROL",
        current: "S:NO_ACCESS_CONTROL",
        expected: false,
      },
      { name: "unknown inherit-required flag", original: "", current: "S:AR", expected: false },
      {
        name: "nonempty original is never equivalent empty",
        original: "S:(ML;OICI;NW;;;ME)",
        current: "S:PAINO_ACCESS_CONTROL",
        expected: false,
      },
    ]
    const result = inspect(helper, "equivalence", { cases })
    assert.deepEqual(
      result,
      cases.map(item => ({ name: item.name, accepted: item.expected })),
    )
  },
)

test(
  "Windows journal retries after partial label restoration without accepting an external label",
  { skip: process.platform !== "win32", timeout: 60000 },
  async t => {
    const runs = path.join(repository, "tests/runs")
    fs.mkdirSync(runs, { recursive: true })
    const root = fs.mkdtempSync(path.join(runs, "windows-cleanup-replay-"))
    const paths = {
      root,
      first: path.join(root, "plugins/first"),
      second: path.join(root, "plugins/second"),
    }
    for (const directory of [paths.first, paths.second]) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(path.join(directory, "original.txt"), "unchanged-business-data")
    }
    const program = path.join(root, "probe.cjs")
    fs.writeFileSync(
      program,
      `const net=require('node:net');const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);socket.once('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));setInterval(()=>{},1000);`,
    )
    const helper = compileWindowsSandbox()
    const before = inspect(helper, "snapshot", { paths })
    assert.equal(before.first.label, "", "Fixture must start without a mandatory label")
    assert.equal(before.second.label, "", "Fixture must start without a mandatory label")
    const child = spawnWindowsSandbox(
      root,
      {
        shutdownTimeout: 1000,
        sandbox: { network: "none", writablePaths: ["plugins/first", "plugins/second"] },
      },
      {
        executable: process.execPath,
        args: [program],
        env: { ...process.env },
        forwardOutput: false,
      },
    )
    let ready = false
    const errors = []
    child.on("message", message => {
      if (message.type === "preload-hello") ready = true
    })
    child.on("error", error => errors.push(error.message))
    let cleanupComplete = false,
      changedLabel = false
    const report = { root, before, errors }
    const journalPath = path.join(child.sandboxSession, "journal.json")
    const activePath = path.join(root, "data/yunzai-guard/windows-sandbox-active.json")
    const clearOwnership = () => {
      if (!fs.existsSync(activePath)) return
      const active = JSON.parse(fs.readFileSync(activePath, "utf8"))
      assert.equal(active.root, root)
      assert.equal(active.session, child.sandboxSession)
      fs.unlinkSync(activePath)
    }
    try {
      const end = performance.now() + 15000
      while (!ready && !errors.length && performance.now() < end)
        await new Promise(resolve => setTimeout(resolve, 20))
      assert.deepEqual(errors, [])
      assert.equal(ready, true)
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"))
      report.sid = journal.sid
      // 模拟对新建无害夹具的宿主修改；第一条记录应还原成功，后续非空标签必须阻止清理。
      inspect(helper, "label", { path: paths.second, label: "S:(ML;OICI;NW;;;ME)" })
      changedLabel = true
      await assert.rejects(child.sandboxDispose(), error => {
        if (!(error instanceof AggregateError)) return false
        const cleanup = error.errors.find(
          cause =>
            cause instanceof AggregateError && cause.message === "沙箱清理或原生输出排空失败",
        )
        const failure = cleanup?.errors.find(
          cause =>
            cause instanceof Error &&
            cause.message.startsWith(`沙箱清理未确认，日志保留在 ${journalPath}：`),
        )
        if (!failure) return false
        report.cleanupFailure = failure.message
        return true
      })
      assert.equal(fs.existsSync(journalPath), true, "Rejected cleanup must retain its journal")
      fs.copyFileSync(journalPath, path.join(root, "retained-journal.json"))
      const partial = inspect(helper, "snapshot", { paths })
      report.partial = partial
      assert.equal(
        partial.first.dacl.includes(journal.sid),
        false,
        "Earlier record must already be restored",
      )
      assert.equal(partial.first.label.includes("(ML;"), false)
      assert.equal(
        partial.second.dacl.includes(journal.sid),
        true,
        "Changed-label record must retain its SID ledger",
      )
      assert.match(partial.second.label, /;;;ME\)/)
      const retry = spawnSync(helper, ["--cleanup", journalPath], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      assert.equal(retry.status, 1, "External mandatory label must still reject cleanup")
      assert.match(retry.stdout, /;;;ME\)/)
      report.rejectedExternalLabel = JSON.parse(retry.stdout.trim())
      assert.equal(fs.existsSync(journalPath), true)
      inspect(helper, "low", { path: paths.second })
      changedLabel = false
      await cleanupWindowsSandbox(helper, child.sandboxSession)
      cleanupComplete = true
      clearOwnership()
      const after = inspect(helper, "snapshot", { paths })
      report.after = after
      for (const [name, snapshot] of Object.entries(after)) {
        assert.equal(snapshot.dacl, before[name].dacl)
        assert.equal(snapshot.dacl.includes(report.sid), false)
        assert.equal(snapshot.label.includes("(ML;"), false)
      }
      for (const directory of [paths.first, paths.second])
        assert.equal(
          fs.readFileSync(path.join(directory, "original.txt"), "utf8"),
          "unchanged-business-data",
        )
      assert.equal(fs.existsSync(child.sandboxSession), false)
      report.status = "partial-journal-replay-passed"
    } finally {
      if (!cleanupComplete) {
        await child.sandboxDispose().catch(() => {})
        if (changedLabel) inspect(helper, "low", { path: paths.second })
        if (fs.existsSync(child.sandboxSession))
          await cleanupWindowsSandbox(helper, child.sandboxSession)
        clearOwnership()
      }
      fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2))
      t.diagnostic(`Benign partial-cleanup recovery evidence retained at ${root}`)
    }
    assert.equal(report.status, "partial-journal-replay-passed")
  },
)
