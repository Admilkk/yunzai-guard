import assert from "node:assert/strict"
import test from "node:test"
import { NativeRegistrationBudget } from "../dist/native-sandbox/registrations.js"

const descriptor = (id, { tasks = 0, handlers = 0, rules = 0 } = {}) => ({
  id,
  name: id,
  methods: ["run"],
  metadata: {
    name: id,
    event: "message",
    priority: 1,
    task: Array.from({ length: tasks }, (_, index) => ({
      name: `${id}-${index}`,
      cron: "* * * * * *",
      fnc: "run",
    })),
    handler: Array.from({ length: handlers }, (_, index) => ({ key: `${id}-${index}`, fn: "run" })),
    rule: Array.from({ length: rules }, () => ({ reg: "^test$", fnc: "run" })),
  },
})

test("native task reservations aggregate across files and reject duplicates without consuming capacity", () => {
  const budget = new NativeRegistrationBudget()
  budget.reserve("alpha", "alpha/a.js", [descriptor("first", { tasks: 40 })])
  assert.throws(
    () => budget.reserve("alpha", "alpha/b.js", [descriptor("second", { tasks: 25 })]),
    /独立插件登记数超限：alpha/,
  )
  budget.reserve("alpha", "alpha/b.js", [descriptor("second", { tasks: 24 })])
  assert.throws(
    () => budget.reserve("alpha", "alpha/b.js", [descriptor("duplicate")]),
    /独立插件文件已登记/,
  )
  assert.throws(
    () => budget.reserve("alpha", "alpha/c.js", [descriptor("third", { tasks: 1 })]),
    /独立插件登记数超限：alpha/,
  )
  budget.release("alpha", "alpha/a.js")
  budget.reserve("alpha", "alpha/c.js", [descriptor("third", { tasks: 40 })])
  assert.throws(
    () => budget.reserve("alpha", "alpha/d.js", [descriptor("fourth", { tasks: 1 })]),
    /独立插件登记数超限：alpha/,
  )
})

test("init metadata changes are checked against peers and failed updates leave the prior reservation intact", () => {
  const budget = new NativeRegistrationBudget()
  budget.reserve("alpha", "alpha/a.js", [descriptor("first", { tasks: 32 })])
  budget.reserve("alpha", "alpha/b.js", [descriptor("second", { tasks: 32 })])
  assert.throws(
    () => budget.update("alpha", "alpha/a.js", descriptor("first", { tasks: 33 })),
    /独立插件登记数超限：alpha/,
  )
  assert.throws(
    () => budget.update("alpha", "alpha/missing.js", descriptor("unknown")),
    /元数据更新没有对应登记/,
  )
  budget.update("alpha", "alpha/b.js", descriptor("second"))
  budget.reserve("alpha", "alpha/c.js", [descriptor("third", { tasks: 32 })])
  assert.throws(
    () => budget.update("alpha", "alpha/b.js", descriptor("second", { tasks: 1 })),
    /独立插件登记数超限：alpha/,
  )
  budget.release("alpha", "alpha/c.js")
  budget.update("alpha", "alpha/b.js", descriptor("second", { tasks: 32 }))
})

test("global native scheduler budget includes each plugin and release frees only its owned registrations", () => {
  const budget = new NativeRegistrationBudget()
  for (const id of ["first", "second", "third", "fourth"])
    budget.reserve(id, `${id}/index.js`, [descriptor(id, { tasks: 64 })])
  assert.throws(
    () => budget.reserve("fifth", "fifth/index.js", [descriptor("fifth", { tasks: 1 })]),
    /独立插件全局计划任务数超限/,
  )
  budget.release("second")
  budget.reserve("fifth", "fifth/index.js", [descriptor("fifth", { tasks: 64 })])
  assert.throws(
    () => budget.reserve("sixth", "sixth/index.js", [descriptor("sixth", { tasks: 1 })]),
    /独立插件全局计划任务数超限/,
  )
  budget.release("missing", "not-registered.js")
  assert.throws(
    () => budget.reserve("sixth", "sixth/index.js", [descriptor("sixth", { tasks: 1 })]),
    /独立插件全局计划任务数超限/,
  )
})

test("whole-plugin rollback releases successful earlier files but never a peer's capacity", () => {
  const budget = new NativeRegistrationBudget()
  budget.reserve("peer", "peer/index.js", [descriptor("peer", { tasks: 64 })])
  budget.reserve("broken", "broken/a.js", [descriptor("first", { tasks: 32 })])
  budget.reserve("broken", "broken/b.js", [descriptor("second", { tasks: 32 })])
  assert.throws(
    () => budget.reserve("broken", "broken/c.js", [descriptor("third", { tasks: 1 })]),
    /独立插件登记数超限：broken/,
  )
  budget.release("broken")
  for (const id of ["replacement-a", "replacement-b", "replacement-c"])
    budget.reserve(id, `${id}/index.js`, [descriptor(id, { tasks: 64 })])
  assert.throws(
    () => budget.reserve("extra", "extra/index.js", [descriptor("extra", { tasks: 1 })]),
    /独立插件全局计划任务数超限/,
  )
})

test("class, handler and rule budgets include many individually valid classes", () => {
  for (const [kind, first, second] of [
    [
      "classes",
      Array.from({ length: 256 }, (_, index) => descriptor(`class-${index}`)),
      [descriptor("extra")],
    ],
    [
      "handlers",
      [descriptor("one", { handlers: 64 }), descriptor("two", { handlers: 64 })],
      [descriptor("extra", { handlers: 1 })],
    ],
    [
      "rules",
      Array.from({ length: 16 }, (_, index) => descriptor(`class-${index}`, { rules: 256 })),
      [descriptor("extra", { rules: 1 })],
    ],
  ]) {
    const budget = new NativeRegistrationBudget()
    budget.reserve("alpha", "alpha/a.js", first)
    assert.throws(
      () => budget.reserve("alpha", "alpha/b.js", second),
      /独立插件登记数超限：alpha/,
      kind,
    )
    budget.release("alpha")
    budget.reserve("alpha", "alpha/b.js", second)
  }
})

test("empty default tasks do not reserve host jobs and invalid duplicate classes commit nothing", () => {
  const budget = new NativeRegistrationBudget()
  const empty = descriptor("empty")
  empty.metadata.task = [{ name: "default", cron: "", fnc: "" }]
  budget.reserve("alpha", "alpha/empty.js", [empty])
  const same = descriptor("duplicate", { tasks: 64 })
  assert.throws(() => budget.reserve("alpha", "alpha/broken.js", [same, same]), /重复的插件类登记/)
  budget.reserve("alpha", "alpha/full.js", [descriptor("full", { tasks: 64 })])
  assert.throws(
    () => budget.reserve("alpha", "alpha/extra.js", [descriptor("extra", { tasks: 1 })]),
    /独立插件登记数超限：alpha/,
  )
})
