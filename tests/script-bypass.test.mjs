import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { analyzeCommand } from "../dist/protect/command-analysis.js"

const blocked = result => result.script || result.limited === true

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-script-bypass-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-script-bypass-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  const ordinary = path.join(directory, "ordinary")
  const binaryDirectory = path.join(directory, "bin")
  fs.mkdirSync(ordinary)
  fs.mkdirSync(binaryDirectory)
  return { directory, ordinary, binaryDirectory }
}

test("env split-string 的等号和连写形式不能隐藏内联脚本", t => {
  const { ordinary } = fixture(t)
  for (const argv of [
    ["-S", "node -e console.log(1)"],
    ["-Snode -e console.log(1)"],
    ["--split-string", "node -e console.log(1)"],
    ["--split-string=node -e console.log(1)"],
  ])
    assert.equal(
      blocked(analyzeCommand("spawn", ["env", argv, { cwd: ordinary, env: { PATH: ordinary } }])),
      true,
      JSON.stringify(argv),
    )
})

test("env 的 PATH 赋值与切换目录参与无扩展脚本识别", t => {
  const { ordinary, binaryDirectory } = fixture(t)
  const name = "guard_unique_script_32871"
  fs.writeFileSync(path.join(binaryDirectory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  for (const [argv, env] of [
    [[`PATH=${binaryDirectory}`, name], { PATH: path.dirname(process.execPath) }],
    [["-i", `PATH=${binaryDirectory}`, name], { PATH: path.dirname(process.execPath) }],
    [["-C", binaryDirectory, name], { PATH: "." }],
  ])
    assert.equal(blocked(analyzeCommand("spawn", ["env", argv, { cwd: ordinary, env }])), true)
})

test(
  "Windows Shell 的 PATHEXT 解析不能把 cmd 脚本视为普通程序",
  { skip: process.platform !== "win32" },
  t => {
    const { ordinary, binaryDirectory } = fixture(t)
    const name = "guard_unique_cmd_32871"
    fs.writeFileSync(path.join(binaryDirectory, `${name}.cmd`), "@exit /b 0\r\n")
    assert.equal(
      blocked(
        analyzeCommand("exec", [
          name,
          {
            cwd: ordinary,
            env: { ...process.env, PATH: binaryDirectory, PATHEXT: ".CMD;.EXE" },
          },
        ]),
      ),
      true,
    )
  },
)

test("当前 Node 的硬链接别名执行代码仍属于脚本，版本查询保留", t => {
  const { ordinary, binaryDirectory } = fixture(t)
  const alias = path.join(
    binaryDirectory,
    process.platform === "win32" ? "ordinary-tool.exe" : "ordinary-tool",
  )
  try {
    fs.linkSync(process.execPath, alias)
  } catch (error) {
    if (["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error.code)) {
      t.skip(`hard link unsupported: ${error.code}`)
      return
    }
    throw error
  }
  assert.equal(fs.statSync(alias).ino, fs.statSync(process.execPath).ino)
  const options = { cwd: ordinary, env: { PATH: binaryDirectory } }
  assert.equal(blocked(analyzeCommand("spawn", [alias, ["-e", "console.log(1)"], options])), true)
  assert.equal(blocked(analyzeCommand("spawn", [alias, ["--version"], options])), false)
})

test("与 Shell 内建命令同名的显式程序仍检查入口", t => {
  const { ordinary, binaryDirectory } = fixture(t)
  const alias = path.join(binaryDirectory, process.platform === "win32" ? "echo.exe" : "echo")
  try {
    fs.linkSync(process.execPath, alias)
  } catch (error) {
    if (["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error.code)) {
      t.skip(`hard link unsupported: ${error.code}`)
      return
    }
    throw error
  }
  const options = { cwd: ordinary, env: { ...process.env, PATH: binaryDirectory } }
  assert.equal(blocked(analyzeCommand("exec", [`"${alias}" -e 1`, options])), true)
  assert.equal(
    blocked(analyzeCommand("spawn", [alias, ["-e", "1"], { ...options, shell: true }])),
    true,
  )
  if (process.platform === "win32")
    assert.equal(blocked(analyzeCommand("exec", ["echo.exe -e 1", options])), true)
  assert.equal(blocked(analyzeCommand("exec", ["echo ordinary", options])), false)
})

test("常见执行包装器的选项值不能隐藏后续解释器", t => {
  const { ordinary } = fixture(t)
  const options = { cwd: ordinary, env: { PATH: path.dirname(process.execPath) } }
  const cases = [
    ["timeout", ["-s", "KILL", "1"]],
    ["timeout", ["--signal", "KILL", "1"]],
    ["timeout", ["--signal=KILL", "1"]],
    ["timeout", ["-k", "2", "1"]],
    ["timeout", ["--kill-after=2", "1"]],
    ["timeout", ["-sKILL", "-k2", "1"]],
    ["exec", ["-a", "ordinary"]],
    ["exec", ["-aordinary", "-cl"]],
    ["time", ["-o", "ordinary.log"]],
    ["time", ["--output=ordinary.log", "-f", "%e"]],
    ["sudo", ["--user", "root"]],
    ["sudo", ["--group=root", "--non-interactive"]],
    ["nice", ["--adjustment", "1"]],
    ["stdbuf", ["-oL"]],
  ]
  for (const [file, prefix] of cases) {
    const result = analyzeCommand("spawn", [
      file,
      [...prefix, process.execPath, "-e", "1"],
      options,
    ])
    assert.equal(result.script, true, JSON.stringify([file, prefix]))
    assert.notEqual(result.limited, true, JSON.stringify([file, prefix]))
  }
  const output = analyzeCommand("spawn", ["time", ["-o", "ordinary.log", "ordinary-tool"], options])
  assert.equal(output.limited, undefined)
  assert.ok(
    output.targets.some(
      target => target.path === path.join(ordinary, "ordinary.log") && target.access === "write",
    ),
  )
  for (const file of ["timeout", "exec", "time", "sudo", "nice", "stdbuf", "nohup", "setsid"])
    assert.equal(
      analyzeCommand("spawn", [
        file,
        ["--unknown-option", "ordinary", process.execPath, "-e", "1"],
        options,
      ]).limited,
      true,
      file,
    )
})

test("Shell 跨命令环境变化不沿用旧 PATH 快照", t => {
  const { ordinary, binaryDirectory } = fixture(t)
  const options = { cwd: ordinary, env: { PATH: ordinary } }
  for (const command of [
    `PATH=${binaryDirectory}; ordinary-tool`,
    `export PATH=${binaryDirectory}; ordinary-tool`,
    "unset PATH; ordinary-tool",
    `set PATH=${binaryDirectory}&&ordinary-tool`,
    `path ${binaryDirectory}&&ordinary-tool`,
  ])
    assert.equal(analyzeCommand("exec", [command, options]).limited, true, command)
  assert.equal(analyzeCommand("exec", ["PATH=/ordinary echo ordinary", options]).limited, undefined)
})

test("显式自定义 shell 脚本和 PowerShell 纳入默认脚本拒绝，隐式 exec 保持普通命令", t => {
  const { ordinary, binaryDirectory } = fixture(t)
  const shell = path.join(binaryDirectory, "custom-shell.sh")
  fs.writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const options = { cwd: ordinary, env: { PATH: binaryDirectory } }
  assert.equal(blocked(analyzeCommand("exec", ["echo ordinary", { ...options, shell }])), true)
  assert.equal(
    blocked(analyzeCommand("spawn", ["echo", ["ordinary"], { ...options, shell }])),
    true,
  )
  assert.equal(
    blocked(
      analyzeCommand("exec", ["Write-Output ordinary", { ...options, shell: "powershell.exe" }]),
    ),
    true,
  )
  assert.equal(blocked(analyzeCommand("exec", ["echo ordinary", options])), false)
})
