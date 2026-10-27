import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function dacl(directory) {
  const encoded = Buffer.from(directory, "utf8").toString("base64")
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$guardTarget=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [IO.Directory]::GetAccessControl($guardTarget).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim()
}

function externalReadRule(directory, add) {
  const encoded = Buffer.from(directory, "utf8").toString("base64")
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$guardTarget=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $guardAcl=[IO.Directory]::GetAccessControl($guardTarget); $guardSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545'); $guardRule=New-Object Security.AccessControl.FileSystemAccessRule($guardSid,[Security.AccessControl.FileSystemRights]::ReadAttributes,[Security.AccessControl.AccessControlType]::Allow); $guardAcl.${add ? "AddAccessRule" : "RemoveAccessRuleSpecific"}($guardRule); [IO.Directory]::SetAccessControl($guardTarget,$guardAcl)`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
}

test(
  "two plugin AppContainers keep independent writable scopes and preserve each other's ACLs on exit",
  {
    skip: process.platform !== "win32",
    timeout: 60000,
  },
  async t => {
    fs.mkdirSync(path.join(repository, "tests/runs"), { recursive: true })
    const root = fs.mkdtempSync(path.join(repository, "tests/runs/native-plugin-launch-"))
    const guard = path.join(root, "plugins/yunzai-guard")
    fs.mkdirSync(guard, { recursive: true })
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}')
    fs.cpSync(path.join(repository, "dist"), path.join(guard, "dist"), { recursive: true })
    fs.cpSync(path.join(repository, "native/windows"), path.join(guard, "native/windows"), {
      recursive: true,
    })
    const state = path.join(root, "data/yunzai-guard")
    fs.mkdirSync(state, { recursive: true })
    fs.mkdirSync(path.join(root, "lib"))
    fs.writeFileSync(path.join(root, "lib/core.txt"), "core-original")
    const pluginRoots = ["first", "second"].map(id => path.join(root, "plugins", id))
    for (const directory of pluginRoots) {
      fs.mkdirSync(directory)
      fs.writeFileSync(path.join(directory, "index.js"), "// plugin-original")
    }
    const entry = path.join(root, "probe.mjs")
    fs.writeFileSync(
      entry,
      `import fs from "node:fs"; import path from "node:path";
    const [own, peer] = process.argv.slice(2);
    process.on("message", message => {
      if (message.type !== "probe") return;
      const results = {};
      for (const [name, file] of Object.entries({ own: path.join(own, "allowed.txt"),
        peer: path.join(peer, "index.js"), peerNew: path.join(peer, "outside.txt"),
        core: path.resolve("lib/core.txt"), root: path.resolve("outside.txt"), state: path.resolve("data/yunzai-guard/outside.txt") })) {
        try { fs.appendFileSync(file, "changed"); results[name] = { allowed: true }; }
        catch (error) { results[name] = { allowed: false, code: error.code, message: error.message }; }
      }
      results.coreReadable = fs.readFileSync("lib/core.txt", "utf8") === "core-original";
      process.send({ type: "probe-result", request: message.request, results });
    });
    process.send({type:"fixture-ready"});
  `,
    )
    const { launchNativeSandbox } = await import(
      pathToFileURL(path.join(guard, "dist/native-sandbox/launch.js"))
    )
    const watchedPaths = [root, state, ...pluginRoots]
    const baseline = watchedPaths.map(dacl)
    const sessions = []
    const observations = []
    let requestId = 0
    const wait = async predicate => {
      const deadline = performance.now() + 15000
      while (performance.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error(
        `Sandbox probe timed out: ${JSON.stringify(observations.map(({ message, error }) => ({ message, error })))}`,
      )
    }
    const inspect = async session => {
      const request = ++requestId
      session.child.send({ type: "probe", request })
      await wait(() =>
        observations.some(row => row.session === session && row.message?.request === request),
      )
      const result = observations.find(
        row => row.session === session && row.message?.request === request,
      ).message.results
      assert.equal(
        result.own.allowed,
        true,
        `Own-directory write failed: ${JSON.stringify(result.own)}`,
      )
      for (const key of ["peer", "peerNew", "core", "root", "state"])
        assert.equal(result[key].allowed, false, `${key} must not be writable`)
      assert.equal(result.coreReadable, true)
    }
    try {
      for (let index = 0; index < pluginRoots.length; index++) {
        const session = await launchNativeSandbox({
          root,
          pluginRoot: pluginRoots[index],
          entry,
          args: [pluginRoots[index], pluginRoots[1 - index]],
          network: "none",
        })
        sessions.push(session)
        session.child.on("message", message => observations.push({ session, message }))
        session.child.on("error", error => observations.push({ session, error: error.message }))
      }
      await Promise.all(sessions.map(session => session.ready))
      await wait(() =>
        sessions.every(session =>
          observations.some(
            row => row.session === session && row.message?.type === "fixture-ready",
          ),
        ),
      )
      const sids = sessions.map(
        session =>
          JSON.parse(
            fs.readFileSync(path.join(session.child.sandboxSession, "journal.json"), "utf8"),
          ).sid,
      )
      assert.notEqual(sids[0], sids[1])
      await Promise.all(sessions.map(inspect))
      // 模拟会话运行期间的宿主 ACL 修改，两次清理都必须保留它。
      externalReadRule(root, true)
      await sessions[0].close()
      assert.equal(dacl(root).includes(sids[0]), false, "Closing first removes only its SID")
      assert.equal(dacl(root).includes(sids[1]), true, "Second SID must remain installed")
      await inspect(sessions[1])
      await sessions[1].close()
      assert.match(dacl(root), /;;;BU\)/, "A later host-side read ACE must survive sandbox cleanup")
      assert.equal(dacl(root).includes(sids[0]), false)
      assert.equal(dacl(root).includes(sids[1]), false)
      externalReadRule(root, false)
      for (const [index, directory] of watchedPaths.entries())
        assert.equal(
          dacl(directory),
          baseline[index],
          `All session ACEs must be removed from ${directory}`,
        )
      assert.equal(fs.readFileSync(path.join(root, "lib/core.txt"), "utf8"), "core-original")
      for (const directory of pluginRoots)
        assert.equal(
          fs.readFileSync(path.join(directory, "index.js"), "utf8"),
          "// plugin-original",
        )
      assert.deepEqual(
        fs.readdirSync(state).filter(name => name.includes("-active.json")),
        [],
      )
      t.diagnostic(`Benign AppContainer fixture retained at ${root}`)
    } finally {
      const results = await Promise.allSettled(sessions.map(session => session.close()))
      const failures = results.filter(result => result.status === "rejected")
      if (failures.length)
        throw new AggregateError(
          failures.map(result => result.reason),
          "Sandbox fixture cleanup failed",
        )
    }
  },
)
