import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("DF 仓库查询可读取 Guard，其他仓库可修改，明确 Guard 修改仍拒绝", t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-git-compat-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-git-compat-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  const guard = path.join(directory, "plugins", "yunzai-guard")
  fs.mkdirSync(guard, { recursive: true })
  const remote = "https://example.invalid/guard.git"
  for (const cwd of [directory, guard])
    for (const args of [
      ["init", "-b", "main"],
      ["remote", "add", "origin", remote],
      ["config", "branch.main.remote", "origin"],
    ]) {
      const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true })
      assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    }
  const sentinel = path.join(guard, "sentinel.txt")
  fs.writeFileSync(sentinel, "original")
  const runtime = new URL("../dist/runtime/index.js", import.meta.url).href
  const config = new URL("../dist/config/index.js", import.meta.url).href
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import {installRuntime} from ${JSON.stringify(runtime)};
    import {parseSettings} from ${JSON.stringify(config)};
    const guard=${JSON.stringify(guard)},directory=${JSON.stringify(directory)};
    const events=[];
    installRuntime({settings:parseSettings({}),stateDir:guard,identity:{id:'git-compat',generation:1,kind:'yunzai',pid:process.pid,originPlugin:'DF',observability:'js-entrypoints'},emit:event=>events.push(event)});
    const queries=[
      ['git rev-parse --abbrev-ref HEAD',null],
      ['git branch --show-current','main'],
      ['git config branch.main.remote','origin'],
      ['git remote get-url origin',${JSON.stringify(remote)}],
      ['git remote -v',null],
      ['git config --get remote.origin.url',${JSON.stringify(remote)}],
    ];
    for(const cwd of [directory,guard])for(const [command,expected] of queries){
      // 新仓库尚无提交，DF 的首个查询允许 Git 原样返回失败，随后走 branch 回退。
      if(command.includes('rev-parse')){const value=cp.spawnSync('git',['rev-parse','--abbrev-ref','HEAD'],{cwd,encoding:'utf8'});assert.equal(value.status,128);continue;}
      const output=cp.execSync(command,{cwd,encoding:'utf8'}).trim();
      if(expected!==null)assert.equal(output,expected);else assert.ok(output.includes('origin'));
    }
    cp.execFileSync('git',['config','compat.parent','changed'],{cwd:directory});
    cp.execFileSync('git',['--work-tree',directory,'config','compat.worktree','changed'],{cwd:directory});
    cp.execFileSync('git',['config','compat.env','changed'],{cwd:directory,env:{...process.env,GIT_WORK_TREE:directory}});
    assert.equal(cp.execFileSync('git',['config','compat.parent'],{cwd:directory,encoding:'utf8'}).trim(),'changed');
    assert.equal(events.some(event=>event.action==='deny'),false);
    for(const args of [
      ['-C',guard,'config','remote.origin.url','https://example.invalid/changed.git'],
      ['-C',guard,'remote','set-url','origin','https://example.invalid/changed.git'],
      ['-C',guard,'reset','--hard'],
      ['-C',directory,'rm','-r','plugins/yunzai-guard'],
    ])assert.throws(()=>cp.execFileSync('git',args),{code:'ERR_GUARD_SELF_PROTECTION'});
    if(process.platform!=='win32'){
      assert.equal(cp.execSync('export LC_ALL=C; git remote get-url origin; unset LC_ALL',{cwd:guard,encoding:'utf8'}).trim(),${JSON.stringify(remote)});
      assert.throws(()=>cp.execSync('export LC_ALL=C; rm sentinel.txt',{cwd:guard}),{code:'ERR_GUARD_SELF_PROTECTION'});
    }
  `,
    ],
    { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 30000 },
  )
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
  assert.equal(fs.readFileSync(sentinel, "utf8"), "original")
})
