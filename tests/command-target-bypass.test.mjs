import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { createCommandGuard } from "../dist/protect/commands.js"
import { parseSettings } from "../dist/config/index.js"

function fixture(t, settings = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-command-targets-"))
  const guard = path.join(directory, "guard")
  const cwd = path.join(directory, "ordinary")
  const target = path.join(guard, "unchanged.txt")
  const source = path.join(cwd, "source.txt")
  t.after(() => {
    const actual = fs.realpathSync(directory)
    assert.equal(path.dirname(actual), temporaryRoot)
    assert.ok(path.basename(actual).startsWith("guard-command-targets-"))
    if (fs.existsSync(target)) assert.equal(fs.readFileSync(target, "utf8"), "original")
    if (fs.existsSync(source)) assert.equal(fs.readFileSync(source, "utf8"), "business")
    fs.rmSync(actual, { recursive: true, force: true })
  })
  fs.mkdirSync(guard)
  fs.mkdirSync(cwd)
  fs.writeFileSync(target, "original")
  fs.writeFileSync(source, "business")
  const check = createCommandGuard({
    roots: [guard],
    readRoots: [path.join(guard, "state")],
    settings: parseSettings(settings),
    originPlugin: () => "target-fixture",
    emit() {},
    deny() {
      throw Object.assign(new Error("protected target"), { code: "ERR_GUARD_SELF_PROTECTION" })
    },
  })
  const call = (program, args, env = {}) =>
    check("spawn", [program, args, { cwd, env: { PATH: "", ...env } }])
  return { cwd, guard, target, source, check, call }
}

test("copy/move/link target-directory short and long variants protect the actual output", t => {
  const app = fixture(t)
  for (const program of ["cp", "mv", "ln"])
    for (const args of [
      [`-t${app.guard}`, app.source],
      ["-t", app.guard, app.source],
      [`--target-directory=${app.guard}`, app.source],
      ["--target-directory", app.guard, app.source],
    ])
      assert.throws(
        () => app.call(program, args),
        { code: "ERR_GUARD_SELF_PROTECTION" },
        `${program} ${args}`,
      )
})

test("curl and wget attached output options cannot hide a protected file", t => {
  const app = fixture(t)
  for (const [program, flag] of [
    ["curl", "-o"],
    ["wget", "-O"],
  ])
    assert.throws(() => app.call(program, [flag + app.target, "https://example.test"]), {
      code: "ERR_GUARD_SELF_PROTECTION",
    })
})

test("sed addressed writes remain file targets and execute commands are scripts", t => {
  const app = fixture(t)
  for (const expression of [
    `1w ${app.target}`,
    `1,2w ${app.target}`,
    `$w ${app.target}`,
    `s/a/b/w ${app.target}`,
  ])
    assert.throws(
      () => app.call("sed", ["-e", expression, app.source]),
      { code: "ERR_GUARD_SELF_PROTECTION" },
      expression,
    )
  assert.doesNotThrow(() => app.call("sed", ["-e", "e node -e console.log(1)", app.source]))
  for (const expression of ["e node -e console.log(1)", "s/a/b/e"])
    assert.doesNotThrow(() => app.call("sed", [`--expression=${expression}`, app.source]))
})

test("symlink followed by parent traversal checks the filesystem target before lexical folding", t => {
  const app = fixture(t)
  const inside = path.join(app.guard, "inside")
  const link = path.join(app.cwd, "jump")
  fs.mkdirSync(inside)
  fs.symlinkSync(inside, link, process.platform === "win32" ? "junction" : "dir")
  assert.throws(() => app.call("touch", [`jump${path.sep}..${path.sep}unchanged.txt`]), {
    code: "ERR_GUARD_SELF_PROTECTION",
  })
  assert.throws(() => app.call("cp", [app.source, `jump${path.sep}..`]), {
    code: "ERR_GUARD_SELF_PROTECTION",
  })
})

test("Bash named stdout/stderr redirection checks files while numeric duplication stays allowed", t => {
  const app = fixture(t, {
    rules: [{ id: "trusted-shell", kind: "process", operation: "execSync", action: "audit" }],
  })
  const quoted = `"${app.target.replaceAll("\\", "/")}"`
  assert.throws(
    () =>
      app.check("execSync", [
        `echo changed >& ${quoted}`,
        { cwd: app.cwd, shell: "/bin/bash", env: { PATH: "" } },
      ]),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
  assert.doesNotThrow(() =>
    app.check("execSync", [
      "echo ordinary 2>&1",
      { cwd: app.cwd, shell: "/bin/bash", env: { PATH: "" } },
    ]),
  )
})

test("copy and xcopy omitted destinations are checked against cwd", t => {
  const app = fixture(t)
  for (const program of ["copy", "xcopy"])
    assert.throws(
      () => app.check("spawn", [program, [app.source], { cwd: app.guard, env: { PATH: "" } }]),
      { code: "ERR_GUARD_SELF_PROTECTION" },
      program,
    )
})

test("Git separate work-tree and explicit environment targets cannot point outside the inspected repository", t => {
  const app = fixture(t)
  const repository = path.join(app.cwd, "repository.git")
  fs.mkdirSync(repository)
  assert.throws(
    () => app.call("git", ["--git-dir", repository, "--work-tree", app.guard, "reset", "--hard"]),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
  assert.throws(
    () => app.call("git", ["reset", "--hard"], { GIT_DIR: repository, GIT_WORK_TREE: app.guard }),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
  assert.throws(
    () =>
      app.call("git", ["add", "source.txt"], { GIT_DIR: repository, GIT_INDEX_FILE: app.target }),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
  assert.throws(
    () =>
      app.call("git", [
        "--git-dir",
        repository,
        "-c",
        `core.worktree=${app.guard}`,
        "reset",
        "--hard",
      ]),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
})
