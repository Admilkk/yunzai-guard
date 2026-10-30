import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "yaml"
import { loadSettings, prepareSettings, settingsDefaults } from "../dist/config/index.js"
import { renderSettings, settingNote } from "../dist/config/settings-file.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-settings-file-"))
const read = (directory, name) => fs.readFileSync(path.join(directory, name), "utf8")

test("旧版 settings.json 转换为带注释的 settings.yaml，所有项原样保留，原文件留作镜像", () => {
  const directory = tmp()
  const legacy = {
    startupTimeout: 60000,
    update: { check: false, window: "02:00-05:00" },
    rules: [{ id: "block", kind: "network", target: "*.example.com", action: "deny" }],
  }
  const original = JSON.stringify(legacy, null, 2)
  fs.writeFileSync(path.join(directory, "settings.json"), original)
  const notices = prepareSettings(directory)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /已转换为 settings\.yaml/)
  const yaml = read(directory, "settings.yaml")
  // 与默认值相同的 startupTimeout 也保留：转换不改变用户写过的任何项。
  assert.deepEqual(parse(yaml), legacy)
  assert.match(yaml, /^# Yunzai Guard 配置/)
  assert.match(yaml, /# 版本检查与自动更新。\nupdate:/)
  assert.match(yaml, /# 等待业务进程启动就绪的最长时间。单位：毫秒。\nstartupTimeout: 60000/)
  assert.equal(read(directory, "settings.json"), original)
  assert.deepEqual(prepareSettings(directory), [])
  assert.equal(loadSettings(directory).update.window, "02:00-05:00")
})

test("修改时保留用户的注释、顺序与格式，只改变化的值", () => {
  const previous = [
    "# 我的配置",
    "update:",
    "  # 关掉检查，内网机器",
    "  check: false # 别改",
    "",
    "# 自己加的说明",
    "startupTimeout: 90000",
    "",
  ].join("\n")
  const text = renderSettings(
    { update: { check: true }, startupTimeout: 90000 },
    { previous, defaults: settingsDefaults(), omitDefaults: true },
  )
  assert.equal(text, previous.replace("check: false", "check: true"))
})

test("控制台保存不新增与默认值相同的项，新增的项带说明", () => {
  const defaults = settingsDefaults()
  const value = structuredClone(defaults)
  value.update.window = "01:00-02:00"
  const text = renderSettings(value, { defaults, omitDefaults: true })
  assert.deepEqual(parse(text), { update: { window: "01:00-02:00" } })
  assert.match(
    text,
    /# 版本检查与自动更新。\nupdate:\n {2}# .*HH:MM-HH:MM.*\n {2}window: 01:00-02:00/,
  )
})

test("默认配置覆盖全部配置项且每项都有说明，内容与当前默认值一致", () => {
  const directory = tmp()
  prepareSettings(directory)
  const text = read(directory, "settings.default.yaml")
  assert.match(text, /^# Yunzai Guard 全部配置项与默认值/)
  assert.deepEqual(parse(text), settingsDefaults())
  const missing = []
  const walk = (value, keys = []) => {
    for (const [key, item] of Object.entries(value)) {
      if (!settingNote([...keys, key])) missing.push([...keys, key].join("."))
      if (item && typeof item === "object" && !Array.isArray(item)) walk(item, [...keys, key])
    }
  }
  walk(settingsDefaults())
  assert.deepEqual(missing, [], "新增配置项须在 setting-help.ts 或 settings-file.ts 中写说明")
  // 没有任何配置时只创建说明，不生成镜像。
  assert.deepEqual(parse(read(directory, "settings.yaml")), null)
  assert.equal(fs.existsSync(path.join(directory, "settings.json")), false)
})

test("settings.yaml 改过后刷新镜像；settings.json 被单独改过时提示无效", () => {
  const directory = tmp()
  fs.writeFileSync(path.join(directory, "settings.yaml"), "startupTimeout: 70000\n")
  prepareSettings(directory)
  assert.deepEqual(JSON.parse(read(directory, "settings.json")), { startupTimeout: 70000 })
  const later = new Date(Date.now() + 5000)
  fs.writeFileSync(path.join(directory, "settings.json"), '{"startupTimeout":80000}')
  fs.utimesSync(path.join(directory, "settings.json"), later, later)
  const notices = prepareSettings(directory)
  assert.match(notices.join(), /settings\.json 的修改不会生效/)
  assert.equal(loadSettings(directory).startupTimeout, 70000)
})

test("读取：YAML 优先，允许 BOM；格式错误报出文件名；旧版 JSON 仍不接受 BOM", () => {
  const directory = tmp()
  fs.writeFileSync(path.join(directory, "settings.json"), '{"startupTimeout":61000}')
  assert.equal(loadSettings(directory).startupTimeout, 61000)
  fs.writeFileSync(path.join(directory, "settings.yaml"), "﻿startupTimeout: 62000\n")
  assert.equal(loadSettings(directory).startupTimeout, 62000)
  fs.writeFileSync(path.join(directory, "settings.yaml"), "update:\n  check: [\n")
  assert.throws(() => loadSettings(directory), /settings\.yaml 格式有误/)
  fs.writeFileSync(path.join(directory, "settings.yaml"), "- a\n")
  assert.throws(() => loadSettings(directory), /顶层必须是键值对象/)
  fs.rmSync(path.join(directory, "settings.yaml"))
  fs.writeFileSync(path.join(directory, "settings.json"), '﻿{"startupTimeout":61000}')
  assert.throws(() => loadSettings(directory), /UTF-8 无 BOM/)
})

test("发布产物使用 dist/vendor 中的 yaml，不依赖外部安装", () => {
  const text = fs.readFileSync(new URL("../dist/config/yaml.js", import.meta.url), "utf8")
  assert.match(text, /from "\.\.\/vendor\/yaml\/browser\/dist\/index\.js"/)
  assert.doesNotMatch(text, /from "yaml"/)
  assert.ok(fs.existsSync(new URL("../dist/vendor/yaml/LICENSE", import.meta.url)))
})

test("仓库中的 settings.example.yaml 与当前默认值一致", () => {
  const text = fs.readFileSync(new URL("../settings.example.yaml", import.meta.url), "utf8")
  assert.deepEqual(
    parse(text),
    settingsDefaults(),
    "默认值变化后请执行 node scripts/build-examples.mjs",
  )
})
