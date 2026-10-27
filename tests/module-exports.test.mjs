import assert from "node:assert/strict"
import test from "node:test"
import { ownFunctionExports } from "../dist/monitor/exports.js"

test("own export metadata recognizes direct functions/classes and explicit local aliases", () => {
  const result = ownFunctionExports(`
    export default class MysApi { getData() {} }
    export function local() {}
    export const arrow = () => 1, factory = function() {}, Class = class {};
    class Local {}
    export { Local as renamed, Local as "quoted name" };
  `)
  assert.deepEqual(
    [...result].sort(),
    ["Class", "arrow", "default", "factory", "local", "quoted name", "renamed"].sort(),
  )
  for (const source of [
    "export default class {}",
    "export default function() {}",
    "export default () => 1",
  ])
    assert.deepEqual([...ownFunctionExports(source)], ["default"])
})

test("foreign aliases and factory results remain deferred even when stored in local bindings", () => {
  assert.deepEqual(
    [
      ...ownFunctionExports(`
    import { Constructor } from './a.js';
    const Alias = Constructor;
    const Made = factory();
    export { Alias, Made, Constructor as Direct };
    export { Constructor as Other } from './a.js';
    export default Constructor;
  `),
    ],
    [],
  )
})

test("binding writes and direct eval cannot arm a possibly foreign hoisted function early", () => {
  for (const source of [
    "import { Constructor } from './a.js'; export let Alias = () => 0; Alias = Constructor;",
    "import { Constructor } from './a.js'; export function Alias() {}; ({ value: Alias } = {value: Constructor});",
    "import { Constructor } from './a.js'; export default class Alias {}; Alias = Constructor;",
    "export function Alias() {}; eval('Alias = foreign');",
  ])
    assert.deepEqual([...ownFunctionExports(source)], [])
  assert.deepEqual(
    [...ownFunctionExports("export const Fixed = () => 0; eval('other = 1');")],
    ["Fixed"],
  )
})

test("modern import attributes parse without executing imports, getters or function bodies", () => {
  assert.deepEqual(
    [
      ...ownFunctionExports(`
    import data from './fixture.json' with { type: 'json' };
    export class Api { static { if(false) throw new Error('never executed') } }
  `),
    ],
    ["Api"],
  )
})
