import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { performance } from "node:perf_hooks"
import { createHash } from "node:crypto"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pnpm =
  process.env.GUARD_TEST_PNPM_CLI ||
  path.join(process.env.APPDATA || "", "npm/node_modules/pnpm/bin/pnpm.cjs")
const enabled = process.platform === "win32" && fs.existsSync(pnpm)

function securitySnapshot(helper, paths) {
  const input = Buffer.from(JSON.stringify({ helper, paths }), "utf8").toString("base64")
  const script = `$ErrorActionPreference='Stop';$inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;$type=[Reflection.Assembly]::LoadFrom($inputData.helper).GetType('GuardSandbox');$method=$type.GetMethod('ReadLabel',[Reflection.BindingFlags]'NonPublic,Static');$result=@{};foreach($item in $inputData.paths.psobject.Properties){$target=$item.Value;$acl=if([IO.Directory]::Exists($target)){[IO.Directory]::GetAccessControl($target)}else{[IO.File]::GetAccessControl($target)};$result[$item.Name]=@{dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);label=$method.Invoke($null,@($target))}};$result|ConvertTo-Json -Depth 4 -Compress`
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    }),
  )
}

test(
  "actual offline pnpm workspace preserves canonical dependency isolation across two AppContainers",
  { skip: !enabled, timeout: 60000 },
  async t => {
    const runs = path.join(repository, "tests/runs")
    fs.mkdirSync(runs, { recursive: true })
    const root = fs.mkdtempSync(path.join(runs, "windows-readonly-deps-"))
    const external = fs.mkdtempSync(path.join(runs, "windows-workspace-external-"))
    fs.writeFileSync(path.join(external, "outside.txt"), "external-original")
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}')
    const testGuard = path.join(root, "fixture-guard")
    fs.mkdirSync(path.join(testGuard, "native/windows"), { recursive: true })
    fs.writeFileSync(path.join(testGuard, "package.json"), '{"type":"module"}')
    fs.cpSync(path.join(repository, "dist"), path.join(testGuard, "dist"), { recursive: true })
    const helperSource = fs.readFileSync(
      path.join(repository, "native/windows/GuardSandbox.cs"),
      "utf8",
    )
    fs.cpSync(path.join(repository, "native/windows"), path.join(testGuard, "native/windows"), {
      recursive: true,
    })
    const packageSource = path.join(root, "packages/fixture-dep"),
      nestedSource = path.join(root, "packages/nested-dep")
    fs.mkdirSync(packageSource, { recursive: true })
    fs.mkdirSync(nestedSource, { recursive: true })
    fs.writeFileSync(
      path.join(packageSource, "package.json"),
      JSON.stringify({
        name: "fixture-dep",
        version: "1.0.0",
        main: "index.js",
        type: "commonjs",
        dependencies: { "nested-dep": "file:../nested-dep" },
      }),
    )
    fs.writeFileSync(
      path.join(nestedSource, "package.json"),
      JSON.stringify({ name: "nested-dep", version: "1.0.0", main: "index.js", type: "commonjs" }),
    )
    fs.writeFileSync(
      path.join(packageSource, "index.js"),
      "module.exports = {marker:require('nested-dep')}\n",
    )
    fs.writeFileSync(
      path.join(nestedSource, "index.js"),
      "module.exports = 'benign-readonly-dependency'\n",
    )
    const plugins = ["first", "second"].map(name => path.join(root, "plugins", name))
    for (const plugin of plugins) {
      fs.mkdirSync(plugin, { recursive: true })
      fs.writeFileSync(
        path.join(plugin, "package.json"),
        JSON.stringify({
          name: path.basename(plugin) + "-fixture",
          version: "1.0.0",
          private: true,
          type: "commonjs",
          dependencies: { "fixture-dep": "file:../../packages/fixture-dep", jiuli: "link:../.." },
        }),
      )
    }
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "jiuli", private: true, type: "commonjs" }),
    )
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - 'plugins/*'\n")
    const pnpmVersion = execFileSync(process.execPath, [pnpm, "--version"], {
      encoding: "utf8",
      windowsHide: true,
    }).trim()
    const installOutput = execFileSync(
      process.execPath,
      [
        pnpm,
        "install",
        "--offline",
        "--ignore-scripts",
        "--ignore-pnpmfile",
        "--no-frozen-lockfile",
        "--store-dir",
        path.join(external, "private-store"),
        "--reporter",
        "append-only",
      ],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30000 },
    )
    const store = fs.realpathSync.native(path.join(plugins[0], "node_modules/fixture-dep"))
    const nested = fs.realpathSync.native(path.join(path.dirname(store), "nested-dep"))
    assert.equal(
      store.startsWith(path.join(root, "node_modules/.pnpm") + path.sep),
      true,
      "pnpm must install its virtual store outside each writable plugin",
    )
    fs.mkdirSync(path.join(store, "readonly-empty"))
    fs.mkdirSync(path.join(root, "lib"))
    fs.writeFileSync(path.join(root, "lib/core.txt"), "core-original")
    const state = path.join(root, "data/yunzai-guard")
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, "private.txt"), "guard-state-original")
    for (const plugin of plugins) {
      fs.symlinkSync(store, path.join(plugin, "node_modules/mutable-dep"), "junction")
      fs.writeFileSync(path.join(plugin, "index.js"), "// benign-owned-file\n")
    }
    const entry = path.join(root, "probe.cjs")
    fs.writeFileSync(
      entry,
      `const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
    const [own,peer,store,external]=process.argv.slice(2),modules=path.join(own,'node_modules'),dep=path.join(modules,'fixture-dep'),file=path.join(dep,'index.js');
    const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);let buffered='';
    socket.once('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));
    socket.on('data',chunk=>{buffered+=chunk;for(;;){const i=buffered.indexOf('\\n');if(i<0)break;const command=JSON.parse(buffered.slice(0,i));buffered=buffered.slice(i+1);if(command.type!=='probe')continue;
      const result={};const attempt=(key,fn)=>{try{result[key]={allowed:true,value:fn()}}catch(error){result[key]={allowed:false,code:error.code,message:error.message}}};
      attempt('ownWrite',()=>fs.appendFileSync(path.join(own,'own-data.txt'),'ok'));
      attempt('readDependency',()=>fs.readFileSync(file,'utf8'));
      attempt('importDependency',()=>require(dep).marker);
      attempt('dependencyWrite',()=>fs.appendFileSync(file,'// unexpected'));
      attempt('dependencyCreate',()=>fs.writeFileSync(path.join(modules,'unexpected.txt'),'unexpected'));
      attempt('dependencyUnlink',()=>fs.unlinkSync(file));
      attempt('dependencyRename',()=>fs.renameSync(file,path.join(dep,'renamed.js')));
      attempt('canonicalWrite',()=>fs.appendFileSync(path.join(store,'index.js'),'// unexpected'));
      attempt('canonicalUnlink',()=>fs.unlinkSync(path.join(store,'index.js')));
      attempt('canonicalCreate',()=>fs.writeFileSync(path.join(store,'unexpected.txt'),'unexpected'));
      attempt('canonicalEmptyRemove',()=>fs.rmdirSync(path.join(store,'readonly-empty')));
      attempt('canonicalDirectoryRename',()=>fs.renameSync(store,path.join(path.dirname(store),'renamed-store')));
      attempt('outsideWrite',()=>fs.appendFileSync(path.join(external,'outside.txt'),'unexpected'));
      attempt('outsideUnlink',()=>fs.unlinkSync(path.join(external,'outside.txt')));
      const fresh=path.join(modules,'external-'+command.request);
      attempt('runtimeInternalJunction',()=>fs.symlinkSync(store,path.join(modules,'internal-'+command.request),'junction'));
      attempt('runtimeJunction',()=>fs.symlinkSync(external,fresh,'junction'));
      attempt('runtimeOutsideWrite',()=>fs.appendFileSync(path.join(fresh,'outside.txt'),'unexpected'));
      attempt('runtimeOutsideUnlink',()=>fs.unlinkSync(path.join(fresh,'outside.txt')));
      const stateLink=path.join(modules,'state-'+command.request);
      attempt('runtimeGuardJunction',()=>fs.symlinkSync(path.resolve('data/yunzai-guard'),stateLink,'junction'));
      attempt('runtimeGuardWrite',()=>fs.appendFileSync(path.join(stateLink,'private.txt'),'unexpected'));
      attempt('runtimeGuardUnlink',()=>fs.unlinkSync(path.join(stateLink,'private.txt')));
      const hard=path.join(own,'runtime-hardlink-'+command.request+'.js');
      attempt('runtimeHardlink',()=>fs.linkSync(path.join(store,'index.js'),hard));
      attempt('runtimeHardlinkWrite',()=>fs.appendFileSync(hard,'unexpected'));
      const outsideHard=path.join(own,'runtime-outside-hardlink-'+command.request+'.txt');
      attempt('runtimeOutsideHardlink',()=>fs.linkSync(path.join(external,'outside.txt'),outsideHard));
      attempt('runtimeOutsideHardlinkWrite',()=>fs.appendFileSync(outsideHard,'unexpected'));
      const mutable=path.join(modules,'mutable-dep');
      const moved=path.join(own,'moved-dependency-'+command.request);
      attempt('moveOwnJunction',()=>fs.renameSync(mutable,moved));
      attempt('movedJunctionWrite',()=>fs.appendFileSync(path.join(moved,'index.js'),'unexpected'));
      attempt('junctionRetarget',()=>{fs.rmdirSync(mutable);fs.symlinkSync(external,mutable,'junction')});
      attempt('retargetOutsideWrite',()=>fs.appendFileSync(path.join(mutable,'outside.txt'),'unexpected'));
      attempt('coreWrite',()=>fs.appendFileSync(path.resolve('lib/core.txt'),'unexpected'));
      attempt('peerWrite',()=>fs.appendFileSync(path.join(peer,'index.js'),'unexpected'));
      const core=path.join(modules,'jiuli');
      attempt('coreBacklinkRead',()=>fs.readFileSync(path.join(core,'lib/core.txt'),'utf8'));
      attempt('coreBacklinkWrite',()=>fs.appendFileSync(path.join(core,'lib/core.txt'),'unexpected'));
      attempt('coreBacklinkGuardRead',()=>fs.readFileSync(path.join(core,'data/yunzai-guard/private.txt'),'utf8'));
      attempt('coreBacklinkGuardWrite',()=>fs.appendFileSync(path.join(core,'data/yunzai-guard/private.txt'),'unexpected'));
      attempt('coreBacklinkPeerWrite',()=>fs.appendFileSync(path.join(core,'plugins',path.basename(peer),'index.js'),'unexpected'));
      socket.write(JSON.stringify({type:'probe-result',request:command.request,result})+'\\n');
    }});setInterval(()=>{},1000);
  `,
    )
    const { compileWindowsSandbox, spawnWindowsSandbox } = await import(
      pathToFileURL(path.join(testGuard, "dist/sandbox/windows.js"))
    )
    const helper = compileWindowsSandbox()
    const { collectWindowsAliases } = await import(
      pathToFileURL(path.join(testGuard, "dist/sandbox/resolution.js"))
    )
    const inside = (parent, file) => file === parent || file.startsWith(parent + path.sep)
    const aliases = collectWindowsAliases(
      root,
      plugins.map(plugin => path.relative(root, plugin)),
    )
    const skippedBacklinks = aliases.skippedWritableBacklinks
    assert.ok(
      plugins.every(plugin =>
        aliases.skippedCoreBacklinks.some(
          link =>
            link.from ===
              path
                .relative(root, path.join(plugin, "node_modules/jiuli"))
                .split(path.sep)
                .join("/") && link.to === ".",
        ),
      ),
    )
    assert.equal(
      aliases.links.some(link => link.to === "."),
      false,
    )
    assert.equal(
      skippedBacklinks.length,
      2,
      "pnpm creates one readonly global backlink per writable workspace package",
    )
    assert.ok(
      skippedBacklinks.every(item => item.from.startsWith("node_modules/.pnpm/node_modules/")),
    )
    for (const item of aliases.links) {
      const target = path.resolve(root, item.to)
      assert.equal(inside(root, target), true)
      assert.equal(
        plugins.some(plugin => inside(plugin, target)),
        false,
        "No alias may target a writable plugin tree",
      )
      assert.equal(inside(state, target), false, "No alias may target Guard state")
    }
    assert.ok(
      aliases.links.length >= 5,
      "All four own-plugin links and nested pnpm dependency links must be present",
    )
    for (const plugin of plugins)
      assert.ok(
        aliases.links.some(
          alias =>
            alias.from ===
            path
              .relative(root, path.join(plugin, "node_modules/fixture-dep"))
              .split(path.sep)
              .join("/"),
        ),
      )
    // 检查可写树时只遍历实体目录，不跟随链接。
    for (const plugin of plugins) {
      const pending = [plugin]
      while (pending.length) {
        const directory = pending.pop()
        for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
          const filename = path.join(directory, item.name),
            stat = fs.lstatSync(filename)
          if (stat.isSymbolicLink()) {
            const canonical = fs.realpathSync.native(filename)
            assert.equal(inside(root, canonical), true)
            assert.equal(
              plugins.some(candidate => inside(candidate, canonical)) || inside(state, canonical),
              false,
            )
          } else if (stat.isDirectory()) pending.push(filename)
          else
            assert.equal(
              stat.nlink,
              1,
              "Ordinary files must never receive write grants through a hardlink",
            )
        }
      }
    }
    const preload = path.join(root, "resolution-preload.mjs")
    fs.writeFileSync(
      preload,
      `import {installSandboxResolution} from ${JSON.stringify(pathToFileURL(path.join(testGuard, "dist/sandbox/resolution.js")).href)};installSandboxResolution(process.env.GUARD_PNPM_TEST_MANIFEST);`,
    )
    const paths = {
      root,
      store,
      storeFile: path.join(store, "index.js"),
      nested,
      nestedFile: path.join(nested, "index.js"),
      external,
      outsideFile: path.join(external, "outside.txt"),
      state,
      stateFile: path.join(state, "private.txt"),
      first: plugins[0],
      firstModules: path.join(plugins[0], "node_modules"),
      second: plugins[1],
      secondModules: path.join(plugins[1], "node_modules"),
    }
    const snapshots = { before: securitySnapshot(helper, paths) }
    const sourceFiles = [
      path.join(store, "index.js"),
      path.join(nested, "index.js"),
      path.join(external, "outside.txt"),
      path.join(state, "private.txt"),
      path.join(root, "lib/core.txt"),
      ...plugins.map(plugin => path.join(plugin, "index.js")),
    ]
    const sourceHashes = () =>
      Object.fromEntries(
        sourceFiles.map(file => [
          file,
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ]),
      )
    const report = {
      root,
      productionEntry: "spawnWindowsSandbox",
      helperSourceSha256: createHash("sha256").update(helperSource).digest("hex"),
      aliases,
      skippedBacklinks,
      pnpm: {
        version: pnpmVersion,
        offline: true,
        ignoreScripts: true,
        installOutput,
        store,
        nested,
        canonicalFileLinks: fs.statSync(path.join(store, "index.js")).nlink,
      },
      sourceHashesBefore: sourceHashes(),
      snapshots,
      results: [],
      sids: [],
      limitations: [
        "Only self-authored offline file dependencies execute; no registry packages or install scripts",
        "Startup ordinary-file hardlink scan is unchanged; runtime hardlink attempts are measured separately",
        "This does not test ACL update races, junction replacement by another host process, or installation updates",
      ],
    }
    const sessionManifests = []
    const sessions = [],
      messages = [],
      errors = []
    const wait = async predicate => {
      const end = performance.now() + 15000
      while (performance.now() < end) {
        if (errors.length) throw new Error(errors.join("\n"))
        if (predicate()) return
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error("Readonly dependency experiment timed out")
    }
    const probe = async index => {
      const request = report.results.length + 1
      sessions[index].send({ type: "probe", request })
      await wait(() =>
        messages.some(frame => frame.index === index && frame.message.request === request),
      )
      const { result } = messages.find(
        frame => frame.index === index && frame.message.request === request,
      ).message
      report.results.push({ index, request, result })
      assert.equal(result.ownWrite.allowed, true)
      assert.equal(result.readDependency.allowed, true)
      assert.equal(result.importDependency.value, "benign-readonly-dependency")
      assert.equal(result.coreBacklinkRead.value, "core-original")
      assert.equal(result.dependencyCreate.allowed, true, "Own link directory remains writable")
      for (const key of [
        "dependencyWrite",
        "dependencyUnlink",
        "dependencyRename",
        "canonicalWrite",
        "canonicalUnlink",
        "canonicalCreate",
        "canonicalEmptyRemove",
        "canonicalDirectoryRename",
        "outsideWrite",
        "outsideUnlink",
        "runtimeOutsideWrite",
        "runtimeOutsideUnlink",
        "runtimeGuardWrite",
        "runtimeGuardUnlink",
        "retargetOutsideWrite",
        "movedJunctionWrite",
        "coreWrite",
        "peerWrite",
        "coreBacklinkWrite",
        "coreBacklinkGuardRead",
        "coreBacklinkGuardWrite",
        "coreBacklinkPeerWrite",
      ])
        assert.equal(result[key].allowed, false, `${key} must be denied`)
      // 原硬链接缺失时，追加操作创建普通自有文件是允许的。
      if (result.runtimeHardlink.allowed) assert.equal(result.runtimeHardlinkWrite.allowed, false)
      if (result.runtimeOutsideHardlink.allowed)
        assert.equal(result.runtimeOutsideHardlinkWrite.allowed, false)
    }
    try {
      for (const [index, plugin] of plugins.entries()) {
        const runtime = fs.mkdtempSync(
          path.join(fs.realpathSync.native(os.tmpdir()), "yunzai-native-runtime-"),
        )
        const runtimeManifest = path.join(runtime, "manifest.json")
        fs.writeFileSync(
          runtimeManifest,
          JSON.stringify({
            version: 1,
            endpoint: `\\\\.\\pipe\\yunzai-guard-native-pnpm-${index}-${createHash("sha256").update(runtime).digest("hex").slice(0, 32)}`,
          }),
        )
        sessionManifests.push({ runtime, file: runtimeManifest })
        const child = spawnWindowsSandbox(
          root,
          {
            shutdownTimeout: 1000,
            sandbox: { network: "none", writablePaths: [path.relative(root, plugin)] },
          },
          {
            executable: process.execPath,
            args: [
              "--import",
              pathToFileURL(preload).href,
              entry,
              plugin,
              plugins[1 - index],
              store,
              external,
            ],
            env: { ...process.env, GUARD_PNPM_TEST_MANIFEST: runtimeManifest },
            runtimeManifest,
            forwardOutput: false,
            sessionKey: `deps-${index}`,
          },
        )
        sessions.push(child)
        child.on("error", error => errors.push(error.message))
        child.on("message", message => messages.push({ index, message }))
        await wait(() =>
          messages.some(frame => frame.index === index && frame.message.type === "preload-hello"),
        )
        report.sids.push(
          JSON.parse(fs.readFileSync(path.join(child.sandboxSession, "journal.json"), "utf8")).sid,
        )
      }
      snapshots.bothActive = securitySnapshot(helper, paths)
      await probe(0)
      await probe(1)
      await sessions[0].sandboxDispose()
      snapshots.firstClosed = securitySnapshot(helper, paths)
      assert.equal(snapshots.firstClosed.root.dacl.includes(report.sids[0]), false)
      assert.equal(snapshots.firstClosed.root.dacl.includes(report.sids[1]), true)
      await probe(1)
      sessions[1].kill("SIGKILL")
      await sessions[1].sandboxCleanup
      snapshots.bothClosed = securitySnapshot(helper, paths)
      for (const name of ["external", "outsideFile"])
        for (const snapshot of Object.values(snapshots))
          assert.deepEqual(
            snapshot[name],
            snapshots.before[name],
            `${name} metadata must never change`,
          )
      for (const name of ["root", "store", "storeFile", "nested", "nestedFile"])
        for (const snapshot of Object.values(snapshots))
          for (const sid of report.sids) {
            const entries = snapshot[name].dacl.split("(").filter(ace => ace.includes(`;;;${sid})`))
            for (const ace of entries)
              assert.match(
                ace,
                /^A;[^;]*;0x1200a9;;;/,
                "Shared dependency may receive only readonly session ACEs",
              )
          }
      for (const name of [
        "store",
        "storeFile",
        "nested",
        "nestedFile",
        "external",
        "outsideFile",
      ]) {
        for (const snapshot of Object.values(snapshots))
          assert.equal(
            snapshot[name].label,
            snapshots.before[name].label,
            `${name} integrity label must never change`,
          )
        assert.deepEqual(
          snapshots.bothClosed[name],
          snapshots.before[name],
          `${name} security must restore exactly`,
        )
      }
      for (const [name, value] of Object.entries(snapshots.bothClosed)) {
        assert.equal(value.dacl, snapshots.before[name].dacl, `${name} DACL must restore exactly`)
        for (const sid of report.sids) assert.equal(value.dacl.includes(sid), false)
        assert.equal(
          value.label.includes("(ML;"),
          false,
          `${name} must retain no low integrity ACE`,
        )
      }
      assert.equal(
        fs.readFileSync(path.join(store, "index.js"), "utf8"),
        "module.exports = {marker:require('nested-dep')}\n",
      )
      assert.equal(fs.readFileSync(path.join(root, "lib/core.txt"), "utf8"), "core-original")
      assert.equal(fs.readFileSync(path.join(external, "outside.txt"), "utf8"), "external-original")
      assert.equal(fs.readFileSync(path.join(state, "private.txt"), "utf8"), "guard-state-original")
      report.sourceHashesAfter = sourceHashes()
      assert.deepEqual(report.sourceHashesAfter, report.sourceHashesBefore)
      assert.equal(report.results[0].result.moveOwnJunction.allowed, true)
      assert.equal(report.results[1].result.moveOwnJunction.allowed, true)
      // 前两次真实清理保留新建链接；验证启动硬链接拒绝前，仅删除指定探针链接。
      for (const row of report.results) {
        const moved = path.join(plugins[row.index], `moved-dependency-${row.request}`)
        if (fs.lstatSync(moved, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(moved)
      }
      const deniedLink = path.join(plugins[0], "host-prepared-hardlink.txt")
      fs.linkSync(path.join(external, "outside.txt"), deniedLink)
      try {
        const rejected = spawnWindowsSandbox(
          root,
          { sandbox: { network: "none", writablePaths: [path.relative(root, plugins[0])] } },
          {
            executable: process.execPath,
            args: [entry, plugins[0], plugins[1], store, external],
            env: { ...process.env },
            forwardOutput: false,
            sessionKey: "reject-hardlink",
          },
        )
        const deniedErrors = []
        let deniedReady = false
        rejected.on("error", error => deniedErrors.push(error.message))
        rejected.on("sandbox-ready", () => {
          deniedReady = true
        })
        await rejected.sandboxCleanup
        assert.equal(deniedReady, false)
        assert.match(deniedErrors.join("\n"), /硬链接文件/)
        assert.equal(fs.existsSync(rejected.sandboxSession), false)
        const unchanged = securitySnapshot(helper, {
          external,
          outsideFile: path.join(external, "outside.txt"),
        })
        assert.deepEqual(unchanged.external, snapshots.before.external)
        assert.deepEqual(unchanged.outsideFile, snapshots.before.outsideFile)
        report.startupHardlink = {
          ready: deniedReady,
          errors: deniedErrors,
          sessionRemoved: true,
          externalSecurityUnchanged: true,
        }
      } finally {
        fs.unlinkSync(deniedLink)
      }
      report.status = "production-pnpm-workspace-isolation-passed"
    } finally {
      const cleanup = await Promise.allSettled(sessions.map(child => child.sandboxDispose()))
      report.cleanup = cleanup.map(result =>
        result.status === "fulfilled" ? "closed" : String(result.reason),
      )
      report.sessionAliases = sessionManifests.map(
        item => JSON.parse(fs.readFileSync(item.file, "utf8")).moduleAliases,
      )
      fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2))
      t.diagnostic(`Production AppContainer + pnpm ${pnpmVersion} evidence retained at ${root}`)
      const failures = cleanup.filter(result => result.status === "rejected")
      if (failures.length)
        throw new AggregateError(
          failures.map(result => result.reason),
          "Production sandbox cleanup failed; runtime evidence retained",
        )
      for (const item of sessionManifests) {
        assert.equal(
          path.dirname(fs.realpathSync.native(item.runtime)),
          fs.realpathSync.native(os.tmpdir()),
        )
        assert.ok(path.basename(item.runtime).startsWith("guard-pnpm-runtime-"))
        fs.rmSync(item.runtime, { recursive: true, force: true })
      }
    }
  },
)
