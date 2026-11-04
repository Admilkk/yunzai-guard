import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { analyzeCommand } from "../dist/protect/command-analysis.js"

const base = path.resolve("tests/runs/command-analysis-fixture")
const protectedFile = path.join(base, "guard", "settings.yaml")
const write = (result, file = protectedFile) =>
  result.targets.some(target => target.access === "write" && target.path === file)
const analyze = (program, argv = [], options = {}) =>
  analyzeCommand("spawn", [program, argv, { cwd: base, ...options }])
const shell = command => analyzeCommand("exec", [command, { cwd: base }])

test("普通 exec 与 native 命令保留审计分类，参数不会出现在可执行目标中", () => {
  for (const command of ["echo hello", 'ffmpeg -i "input.mp4" "output.mp4"', "git --version"])
    assert.equal(shell(command).script, false, command)
  const result = shell("echo private-token=example")
  assert.equal(result.executable, "echo")
  assert.equal(result.executable.includes("private-token"), false)
  assert.deepEqual(shell('echo "guard/settings.yaml"').targets, [])
})

test("显式解释器、脚本扩展、fork 及内联代码属于脚本，帮助与版本查询不误拦", () => {
  for (const [program, argv] of [
    ["sh", ["run"]],
    ["bash", ["-c", "echo hello"]],
    ["cmd.exe", ["/c", "echo hi"]],
    ["powershell.exe", ["-Command", "Write-Host hi"]],
    ["pwsh", ["-File", "run.ps1"]],
    ["node", ["run.js"]],
    [process.execPath, ["-e", "console.log(1)"]],
    ["python3.12", ["run.py"]],
    ["perl", ["-e", "print 1"]],
    ["./run.mjs", []],
    ["./run.cmd", []],
    ["env", ["VAR=value", "node", "run.js"]],
  ])
    assert.equal(analyze(program, argv).script, true, program)
  for (const program of ["node", "python", "bash", "pwsh"])
    assert.equal(analyze(program, ["--version"]).script, false, program)
  assert.equal(analyzeCommand("fork", ["module", [], { cwd: base }]).script, true)
  assert.equal(
    analyzeCommand("spawn", ["echo", ["hello"], { cwd: base, shell: true }]).script,
    false,
  )
})

test("相对路径、URL cwd 与不同工作目录均按实际目标解析", () => {
  assert.equal(write(analyze("touch", ["guard/settings.yaml"])), true)
  assert.equal(write(analyze("touch", ["settings.yaml"], { cwd: path.join(base, "guard") })), true)
  assert.equal(
    write(analyze("touch", ["settings.yaml"], { cwd: pathToFileURL(path.join(base, "guard")) })),
    true,
  )
  assert.equal(
    write(
      analyze("truncate", ["-s", "0", "../guard/settings.yaml"], {
        cwd: path.join(base, "ordinary"),
      }),
    ),
    true,
  )
})

test("fork URL 模块转换为同一文件读取目标", () => {
  const result = analyzeCommand("fork", [pathToFileURL(protectedFile), [], { cwd: base }])
  assert.equal(result.script, true)
  assert.equal(result.executable, protectedFile)
  assert.ok(
    result.targets.some(target => target.access === "read" && target.path === protectedFile),
  )
})

test("修改目标覆盖删除、追加、元数据、重命名、dd 和 sed 原地替换", () => {
  for (const [program, argv] of [
    ["rm", ["-rf", "guard/settings.yaml"]],
    ["rm", ["-d", "guard/settings.yaml"]],
    ["tee", ["-a", "guard/settings.yaml"]],
    ["touch", ["guard/settings.yaml"]],
    ["truncate", ["-s", "0", "guard/settings.yaml"]],
    ["chmod", ["644", "guard/settings.yaml"]],
    ["chmod", ["-w", "guard/settings.yaml"]],
    ["chown", ["nobody", "guard/settings.yaml"]],
    ["ren", ["guard/settings.yaml", "renamed"]],
    ["dd", ["if=input", "of=guard/settings.yaml"]],
    ["sed", ["-i.bak", "s/a/b/", "guard/settings.yaml"]],
    ["sed", ["-n", "w guard/settings.yaml", "ordinary"]],
    ["attrib", ["+r", "guard/settings.yaml"]],
    ["icacls", ["guard/settings.yaml", "/grant", "user:F"]],
  ])
    assert.equal(write(analyze(program, argv)), true, `${program} ${argv}`)
})

test("shell cd 先于后续重定向检查，保留条件失败分支；fd 重定向不作为文件", () => {
  for (const command of [
    "cd guard && echo changed > settings.yaml",
    'cd guard; echo changed >> "settings.yaml"',
    'echo changed > "guard/settings.yaml"',
    'echo changed >> "guard/settings.yaml"',
  ])
    assert.equal(write(shell(command)), true, command)
  assert.equal(write(shell("cd ordinary || touch guard/settings.yaml")), true)
  assert.deepEqual(shell("echo changed 2>&1").targets, [])
})

test("显式 shell 和 PowerShell 内联文件操作仍给出固定自保护目标", () => {
  for (const [program, argv] of [
    ["sh", ["-c", "echo changed > guard/settings.yaml"]],
    ["cmd.exe", ["/c", "copy", "source", "guard/settings.yaml"]],
    ["pwsh", ["-Command", "Set-Content -Path guard/settings.yaml -Value changed"]],
    ["powershell", ["-Command", "Add-Content guard/settings.yaml changed"]],
    ["pwsh", ["-Command", "Out-File -FilePath guard/settings.yaml"]],
    ["pwsh", ["-Command", "Remove-Item guard/settings.yaml"]],
    ["pwsh", ["-Command", "Copy-Item source guard/settings.yaml"]],
    ["pwsh", ["-Command", "Move-Item source guard/settings.yaml"]],
  ])
    assert.equal(write(analyze(program, argv)), true, program)
})

test("Guard 源码输入只读，控制目录脚本与显式可执行入口也产生读目标", () => {
  for (const result of [
    analyze("cat", ["guard/settings.yaml"]),
    analyze("ffmpeg", ["-i", "guard/settings.yaml", "output.png"]),
  ]) {
    assert.equal(write(result), false)
    assert.ok(
      result.targets.some(target => target.path === protectedFile && target.access === "read"),
    )
  }
  for (const result of [
    analyze("node", ["guard/settings.yaml"]),
    analyze("./guard/secret-tool", []),
  ])
    assert.ok(
      result.targets.some(
        target =>
          target.path ===
            (result.executable.includes("secret-tool")
              ? path.join(base, "guard/secret-tool")
              : protectedFile) && target.access === "read",
      ),
    )
})

test("复制到既有目录按源文件名计算输出，不把整个父目录当作覆盖目标", t => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-command-copy-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith("guard-command-copy-"))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(directory, "ordinary.txt"), "unchanged")
  const result = analyze("cp", ["ordinary.txt", "."], { cwd: directory })
  assert.deepEqual(
    result.targets
      .filter(target => target.access === "write")
      .map(({ path, access }) => ({ path, access })),
    [{ path: path.join(directory, "ordinary.txt"), access: "write" }],
  )
  const sub = path.join(directory, "sub")
  fs.mkdirSync(sub)
  assert.equal(
    write(
      analyze("cp", ["ordinary.txt", "sub"], { cwd: directory }),
      path.join(sub, "ordinary.txt"),
    ),
    true,
  )
})

test("Git 修改按 -C 或 cwd 检查，status 可能刷新索引所以保守标记写入", () => {
  for (const command of ["reset", "checkout", "apply", "status"])
    assert.equal(write(analyze("git", ["-C", "guard", command]), path.join(base, "guard")), true)
  assert.equal(
    write(analyze("git", ["reset"], { cwd: path.join(base, "guard") }), path.join(base, "guard")),
    true,
  )
  assert.equal(write(analyze("git", ["-C", "guard", "log"]), path.join(base, "guard")), false)
})

test("媒体输出 basename 与受保护 cwd 下未知工具仍有写目标", () => {
  const directory = path.join(base, "guard")
  for (const program of ["ffmpeg", "convert", "magick"])
    assert.equal(
      write(analyze(program, ["-i", "ordinary.input", "settings.yaml"], { cwd: directory })),
      true,
    )
  assert.equal(
    write(analyze("curl", ["-o", "settings.yaml", "https://example.test"], { cwd: directory })),
    true,
  )
  assert.equal(write(analyze("unknown-tool", ["message"], { cwd: directory }), directory), true)
  assert.equal(write(analyze("pwd", [], { cwd: directory }), directory), false)
})

test("常见包装器不会隐藏脚本，env 切换目录后解析修改目标", () => {
  assert.equal(analyze("timeout", ["5", "node", "run.js"]).script, true)
  assert.equal(analyze("nice", ["-n", "10", "python", "run.py"]).script, true)
  assert.equal(analyze("npm", ["run", "build"]).script, true)
  assert.equal(write(analyze("env", ["-C", "guard", "touch", "settings.yaml"])), true)
  assert.equal(shell("$PROGRAM settings.yaml").limited, true)
})

test("env 清空环境不消费后续程序参数，带值选项仍正确定位程序", () => {
  for (const argv of [
    ["-i", "python", "-c", "print(1)"],
    ["--ignore-environment", "node", "-e", "console.log(1)"],
    ["-i", "-u", "UNUSED", "node", "run.js"],
  ])
    assert.equal(analyze("env", argv).script, true)
  assert.equal(analyze("env", ["-i", "ffmpeg", "-version"]).script, false)
})

test("PowerShell Copy/Move-Item 命名源目标不依赖参数顺序", () => {
  for (const command of ["Copy-Item", "Move-Item"])
    for (const content of [
      `${command} -Destination guard/settings.yaml -Path source`,
      `${command} -Path source -Destination guard/settings.yaml`,
      `${command} -DESTINATION:guard/settings.yaml -LiteralPath source`,
    ]) {
      const result = analyze("pwsh", ["-Command", content])
      assert.equal(write(result), true, content)
      if (command === "Copy-Item")
        assert.equal(
          result.targets.some(target => target.path === protectedFile && target.access === "read"),
          false,
        )
    }
})

test("PowerShell 常见字面路径使用独立单引号和反引号词法", () => {
  const expected = path.join(base, "guard space", "settings.yaml")
  const quoted = analyze("pwsh", [
    "-Command",
    "Set-Content -LiteralPath 'guard space/settings.yaml' -Value changed",
  ])
  assert.equal(write(quoted, expected), true)
  const escaped = analyze("pwsh", [
    "-Command",
    "Set-Content -LiteralPath guard` space/settings.yaml -Value changed",
  ])
  assert.equal(write(escaped, expected), true)
  if (process.platform === "win32") {
    const absolute = path.join(base, "Guard Space", "settings.yaml")
    assert.equal(
      write(
        analyze("pwsh", ["-Command", `Set-Content -LiteralPath '${absolute}' -Value changed`]),
        absolute,
      ),
      true,
    )
  }
})

test("Git diff 输出是写目标，执行程序配置仅在明确键上视为脚本", () => {
  for (const argv of [
    ["diff", "--output", "guard/settings.yaml"],
    ["diff", "--output=guard/settings.yaml"],
    ["diff", "-o", "guard/settings.yaml"],
    ["-C", "guard", "diff", "--output", "settings.yaml"],
    ["-C", "ordinary", "-C", "../guard", "diff", "--output", "settings.yaml"],
  ])
    assert.equal(write(analyze("git", argv)), true, argv.join(" "))
  for (const configuration of [
    "core.sshCommand=anything",
    "core.editor=anything",
    "diff.external=anything",
    "filter.test.process=anything",
    "alias.test=!anything",
  ])
    assert.equal(analyze("git", ["-c", configuration, "diff"]).script, true, configuration)
  assert.equal(analyze("git", ["-c", "core.safecrlf=false", "diff"]).script, false)
})

test("shebang 入口使用有界文件头检查，正文不会被执行", t => {
  const directory = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "guard-command-shebang-"),
  )
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith("guard-command-shebang-"))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(directory, "tool"), "#!/bin/sh\necho never-run\n", { mode: 0o755 })
  assert.equal(analyze("./tool", [], { cwd: directory }).script, true)
  assert.equal(analyze("tool", [], { cwd: directory, env: { PATH: directory } }).script, true)
  for (const name of ["env", "timeout", "nice", "busybox"]) {
    fs.writeFileSync(path.join(directory, name), "#!/bin/sh\necho never-run\n", { mode: 0o755 })
    assert.equal(analyze(`./${name}`, [], { cwd: directory }).script, true, name)
  }
  const longSearch = Array.from({ length: 64 }, (_, index) =>
    path.join(directory, `absent-${index}`),
  )
  longSearch.push(directory)
  const searchCwd = path.join(directory, "ordinary")
  fs.mkdirSync(searchCwd)
  assert.equal(
    analyze("tool", [], { cwd: searchCwd, env: { PATH: longSearch.join(path.delimiter) } }).limited,
    true,
  )
  assert.equal(
    analyze("tool", [], { cwd: directory, env: { PATH: "x".repeat(140000) } }).limited,
    true,
  )
  assert.equal(
    analyzeCommand("exec", ["echo ordinary", { cwd: directory, env: { PATH: "x".repeat(140000) } }])
      .limited,
    undefined,
  )
  if (process.platform === "win32")
    assert.equal(analyze("tool", [], { cwd: directory, env: { pAtH: directory } }).script, true)
})

test("扫描预算和动态 shell 文件目标不会被静默截断，通配变更核对父目录", () => {
  assert.equal(shell('echo "unterminated').limited, true)
  assert.equal(shell("echo " + "a".repeat(140000)).limited, true)
  assert.equal(shell("touch $TARGET").limited, true)
  assert.ok(
    shell("rm -rf guard/*").targets.some(
      target => target.path === path.join(base, "guard") && target.ancestors,
    ),
  )
})

test("显式嵌套 shell 的动态目标与程序名也触发有界拒绝，source 和 eval 属于脚本", () => {
  assert.equal(analyze("sh", ["-c", "touch $TARGET"]).limited, true)
  assert.equal(analyze("sh", ["-c", "$PROGRAM ordinary"]).limited, true)
  assert.equal(analyze("cmd", ["/c", "touch $TARGET"]).limited, true)
  assert.equal(shell("source run.sh").script, true)
  assert.equal(shell(". run.sh").script, true)
  assert.equal(write(shell('eval "touch guard/settings.yaml"')), true)
  if (process.platform !== "win32") {
    assert.equal(shell('echo "$(touch guard/settings.yaml)"').limited, true)
    assert.equal(shell('echo "`touch guard/settings.yaml`"').limited, true)
  }
})

test("业务原型污染不能关闭解析或修改目标识别", () => {
  const original = Array.prototype.some
  let result
  try {
    Array.prototype.some = () => false
    result = analyze("chmod", ["644", "guard/settings.yaml"])
  } finally {
    Array.prototype.some = original
  }
  assert.equal(write(result), true)
})

test("路径展示可规范化，交给文件保护的 raw 保留链接和 .. 的顺序", () => {
  const raw = `${base}${path.sep}jump${path.sep}..${path.sep}settings.yaml`
  const result = analyze("touch", [`jump${path.sep}..${path.sep}settings.yaml`])
  assert.ok(result.targets.some(target => target.access === "write" && target.raw === raw))
  const newline = path.join(base, "settings\n.yaml")
  assert.equal(write(analyze("touch", ["settings\n.yaml"]), newline), true)
})

test("非法 cwd 不会跳过对命令和参数的分析", () => {
  const result = analyze("touch", [protectedFile], { cwd: 42 })
  assert.equal(result.limited, true)
  assert.equal(write(result), true)
})

test(
  "Windows 文件目标保留当前驱动器语义，驱动器相对目标保守拒绝",
  {
    skip: process.platform !== "win32",
  },
  () => {
    for (const file of ["C:", "C:relative"])
      assert.equal(analyze("touch", [file]).limited, true, file)
    const target = analyze("touch", ["\\guard\\settings.yaml"], { cwd: "Z:\\ordinary" })
    assert.ok(target.targets.some(value => value.path === "Z:\\guard\\settings.yaml"))
  },
)
