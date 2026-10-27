import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const privateDist = process.env.GUARD_TEST_PRIVATE_DIST
  ? path.resolve(process.env.GUARD_TEST_PRIVATE_DIST)
  : path.join(repo, "dist")
const implementation = pathToFileURL(path.join(privateDist, "monitor/modules.js")).href
const { installModuleAudit, MODULE_AUDIT_LIMITS } = await import(implementation)

test("repeated coverage at many modules cannot hide a later distinct quota fault", () => {
  const root = path.join(os.tmpdir(), "guard-module-coverage-reasons")
  const events = []
  const audit = installModuleAudit({
    root,
    guardRoot: path.join(root, "plugins/guard"),
    emit: event => events.push(event),
  })
  try {
    for (let index = 0; index < MODULE_AUDIT_LIMITS.coverageReports + 5; index++)
      audit.instrument(
        pathToFileURL(path.join(root, `plugins/coverage/${index}.cjs`)).href,
        "commonjs",
        undefined,
      )
    for (let index = 0; index < MODULE_AUDIT_LIMITS.modules + 1; index++)
      audit.instrument(
        pathToFileURL(path.join(root, `plugins/coverage/${index}.js`)).href,
        "module",
        "export const value=1",
      )
    assert.equal(events.filter(event => event.details.reason === "unsupported-format").length, 1)
    assert.equal(events.filter(event => event.details.reason === "module-limit").length, 1)
    assert.ok(events.length <= MODULE_AUDIT_LIMITS.coverageReports)
  } finally {
    audit.close()
  }
})

test("new numeric properties at a full slot budget do not remove unchanged old targets", () => {
  const dense = `export default class Subject {${Array.from({ length: 253 }, (_, index) => `m${index}(){return ${index}}`).join("")}}`
  const files = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [`plugins/load/m${index}.js`, dense]),
  )
  const result = fixture(
    files,
    `
    const modules=[];for(let index=0;index<64;index++)modules.push(await import('./plugins/load/m'+index+'.js'));
    const Subject=modules[0].default,original=Subject.prototype.m252;
    Subject.prototype['0']=()=>7;audit.check('editor');
    const afterAddition=auditEvents.filter(event=>event.operation==='module-function-change');
    const unchanged=Subject.prototype.m252===original;
    Subject.prototype.m252=()=>999;audit.check('editor');
    console.log(JSON.stringify({unchanged,value:new Subject().m252(),afterAddition,events:auditEvents}));
  `,
  )
  assert.equal(result.unchanged, true)
  assert.deepEqual(result.afterAddition, [])
  assert.equal(result.value, 999)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 1)
  assert.equal(changes[0].target, "plugins/load/m0.js#default.prototype.m252")
  assert.equal(changes[0].details.reason, "descriptor")
  assert.ok(result.events.some(event => event.details?.reason === "slot-limit"))
})

test("full promotion preserves a previously owned target when all global slots are occupied", () => {
  const dense = `export default class Subject {${Array.from({ length: 253 }, (_, index) => `m${index}(){return ${index}}`).join("")}}`
  const files = Object.fromEntries(
    Array.from({ length: 63 }, (_, index) => [`plugins/load/m${index}.js`, dense]),
  )
  files["plugins/target/index.js"] =
    `import {Foreign} from '../pending/index.js';export {Foreign as A};${dense}`
  files["plugins/pending/index.js"] =
    "export {default as Target} from '../target/index.js';export function Foreign(){};"
  const result = fixture(
    files,
    `
    for(let index=0;index<63;index++)await import('./plugins/load/m'+index+'.js');
    const {default:Target}=await import('./plugins/target/index.js');audit.check();
    Target.prototype.m249=()=>999;audit.check('editor');
    console.log(JSON.stringify({value:new Target().m249(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 999)
  assert.ok(
    result.events.some(
      event =>
        event.operation === "module-function-change" &&
        event.target === "plugins/target/index.js#default.prototype.m249",
    ),
  )
  assert.ok(result.events.some(event => event.details?.reason === "slot-limit"))
})

test("special property labels stay stable when earlier numeric keys are added", () => {
  const result = fixture(
    { "plugins/unicode/index.js": 'export default class Subject {["方法"](){return 7}}' },
    `
    const {default:Subject}=await import('./plugins/unicode/index.js');
    const original=Subject.prototype['方法'];Subject.prototype['0']=()=>8;audit.check('editor');
    const afterAddition=auditEvents.filter(event=>event.operation==='module-function-change');
    const unchanged=Subject.prototype['方法']===original;Subject.prototype['方法']=()=>9;audit.check('editor');
    console.log(JSON.stringify({unchanged,value:new Subject()['方法'](),afterAddition,events:auditEvents}));
  `,
  )
  assert.equal(result.unchanged, true)
  assert.equal(result.value, 9)
  assert.equal(result.afterAddition.length, 1)
  assert.equal(result.afterAddition[0].details.reason, "added")
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 2)
  assert.equal(changes[1].details.reason, "descriptor")
  assert.notEqual(changes[0].target, changes[1].target)
  assert.doesNotMatch(JSON.stringify(changes), /方法/)
})

test("own class exports remain observable while a recorded cycle member has not completed", () => {
  const result = fixture(
    {
      "plugins/genshin/api.js": "export default class Api { getData(){return 'original'} }",
      "plugins/pending/index.js": "export const pending = true",
      "plugins/ji-plugin/index.js": `import Api from '../genshin/api.js';
      export class Replacement {getData(){return 'hooked'}}
      Api.prototype.getData=Replacement.prototype.getData;`,
    },
    `
    const apiURL=new URL('./plugins/genshin/api.js',import.meta.url).href;
    const pendingURL=new URL('./plugins/pending/index.js',import.meta.url).href;
    // 模拟已观测但尚未执行到求值结尾的循环成员。
    audit.instrument(pendingURL,'module','export const pending=true');
    audit.resolve(apiURL,pendingURL);audit.resolve(pendingURL,apiURL);
    const {default:Api}=await import(apiURL);
    await import('./plugins/ji-plugin/index.js');audit.check();
    console.log(JSON.stringify({value:new Api().getData(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, "hooked")
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 1)
  assert.equal(changes[0].target, "plugins/genshin/api.js#default.prototype.getData")
  assert.equal(changes[0].plugin, "ji-plugin")
})

test("new graph edges invalidate cached components before promoting uncertain exports", () => {
  const result = fixture(
    {
      "plugins/prime/index.js": "export const ready=true",
      "plugins/next/index.js": "export const ready=true",
      "plugins/subject/index.js": `export const Subject=(()=>class Subject {run(){return 1}})();
        export class Own {run(){return 2}}`,
      "plugins/editor/index.js": `import {Subject,Own} from '../subject/index.js';
        export function replacement(){return 8};
        Subject.prototype.run=replacement;Own.prototype.run=replacement;`,
    },
    `
    await import('./plugins/prime/index.js');
    const subject=new URL('./plugins/subject/index.js',import.meta.url).href;
    const pending=new URL('./plugins/pending/index.js',import.meta.url).href;
    audit.instrument(pending,'module','export const pending=true');
    audit.resolve(subject,pending);
    await import('./plugins/next/index.js');
    // 缓存无环组件表后，再连接已有节点形成循环。
    audit.resolve(pending,subject);
    const {Subject,Own}=await import(subject);
    await import('./plugins/editor/index.js');audit.check();
    console.log(JSON.stringify({value:new Subject().run(),own:new Own().run(),events:auditEvents}));
    `,
  )
  assert.equal(result.value, 8)
  assert.equal(result.own, 8)
  assert.ok(result.events.some(event => event.details?.reason === "cyclic-baseline-deferred"))
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.deepEqual(
    changes.map(event => event.target),
    ["plugins/subject/index.js#Own.prototype.run"],
  )
  assert.equal(changes[0].plugin, "editor")
})

function fixture(files, body, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-module-audit-"))
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n')
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(root, name)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, source)
  }
  const sources = Object.fromEntries(
    Object.keys(files).map(name => [
      name,
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, name)))
        .digest("hex"),
    ]),
  )
  fs.writeFileSync(
    path.join(root, "preload.mjs"),
    `
    import {registerHooks} from 'node:module';
    import {installModuleAudit} from ${JSON.stringify(implementation)};
    import {installHookWatch} from ${JSON.stringify(pathToFileURL(path.join(privateDist, "monitor/watch.js")).href)};
    globalThis.hookWatch=${extra.watch ? "installHookWatch()" : "undefined"};
    globalThis.auditEvents=[];
    globalThis.auditEmissionFailures=0;
    globalThis.trustedOriginals=new WeakMap();
    globalThis.audit=installModuleAudit({
      root:${JSON.stringify(root)}, guardRoot:${JSON.stringify(path.join(root, "plugins/yunzai-guard"))},
      intervalMs:${JSON.stringify(extra.intervalMs ?? 10)},
      watch:hookWatch,
      contextPlugin:()=>{${extra.contextThrows ? "throw Error('context failure');" : "return globalThis.currentPlugin;"}},
      originalFunction:value=>trustedOriginals.get(value)??value,
      emit:event=>{globalThis.auditEvents.push(event);${extra.emitThrows ? "globalThis.auditEmissionFailures++; throw Error('emission failure');" : ""}}
    });
    registerHooks({resolve(specifier,context,nextResolve){const result=nextResolve(specifier,context);audit.resolve(context.parentURL,result.url);return result},load(url,context,nextLoad){
      const result=nextLoad(url,context);
      const replacement=audit.instrument(url,result.format,result.source);
      return replacement===undefined ? result : {...result,source:replacement};
    }});
  `,
  )
  fs.writeFileSync(
    path.join(root, "main.mjs"),
    `
    try {
      ${body}
    } finally {audit.close();hookWatch?.close();}
  `,
  )
  const result = execFileSync(
    process.execPath,
    ["--import", pathToFileURL(path.join(root, "preload.mjs")).href, path.join(root, "main.mjs")],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    },
  )
  const after = Object.fromEntries(
    Object.keys(files).map(name => [
      name,
      createHash("sha256")
        .update(fs.readFileSync(path.join(root, name)))
        .digest("hex"),
    ]),
  )
  assert.deepEqual(after, sources, "instrumentation must not modify source files")
  return JSON.parse(result.trim())
}

test("explicit ESM hooks are recorded immediately even when restored before polling", () => {
  const result = fixture(
    { "plugins/subject/index.js": "export default class Subject {run(){return 1}}" },
    `
    const {default:Subject}=await import('./plugins/subject/index.js');
    const original=Subject.prototype.run;globalThis.currentPlugin='editor';
    Object.defineProperty(Subject.prototype,'run',{value:()=>9});
    const hooked=new Subject().run();
    Reflect.set(Subject.prototype,'run',original);audit.check();
    Object.defineProperty(Subject,'version',{value:'1',configurable:true});
    console.log(JSON.stringify({hooked,restored:new Subject().run(),events:auditEvents}));
    `,
    { watch: true },
  )
  assert.equal(result.hooked, 9)
  assert.equal(result.restored, 1)
  const hooks = result.events.filter(event => event.operation === "module-function-change")
  assert.deepEqual(
    hooks.map(event => event.details.method),
    ["Object.defineProperty", "Reflect.set"],
  )
  assert.ok(hooks.every(event => event.action === "audit" && event.plugin === "editor"))
  assert.ok(hooks.every(event => event.details.detection === "during-call"))
  const metadata = result.events.filter(event => event.operation === "module-function-hook")
  assert.equal(metadata.length, 1)
  assert.equal(metadata[0].target, "plugins/subject/index.js#default.version")
})

test("real ESM prototype replacement remains effective and is attributed to its observed export", () => {
  const result = fixture(
    {
      "plugins/genshin/model/MysApi.js":
        "export default class MysApi { getData() { return 'original' } }",
      "plugins/ji-plugin/index.js": `
      import MysApi from '../genshin/model/MysApi.js';
      const original=MysApi.prototype.getData;
      export function replacement(){return 'ji:'+original.call(this)}
      MysApi.prototype.getData=replacement;
      export const used=()=>new MysApi().getData();
    `,
    },
    `
    const {used,replacement}=await import('./plugins/ji-plugin/index.js?privateToken=do-not-log');
    const {default:MysApi}=await import('./plugins/genshin/model/MysApi.js');
    audit.check();
    console.log(JSON.stringify({value:used(),same:MysApi.prototype.getData===replacement,events:auditEvents}));
  `,
  )
  assert.equal(result.value, "ji:original")
  assert.equal(result.same, true)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 1)
  assert.equal(changes[0].target, "plugins/genshin/model/MysApi.js#default.prototype.getData")
  assert.equal(changes[0].plugin, "ji-plugin")
  assert.equal(changes[0].details.attribution, "observed-function")
  assert.equal(changes[0].action, "audit")
  assert.equal(changes[0].details.blocked, false)
  assert.doesNotMatch(
    JSON.stringify(result.events),
    /do-not-log|privateToken|file:|guard-module-audit-/,
  )
})

test("non-exported wrappers use the completing plugin; periodic late changes remain effective", () => {
  const result = fixture(
    {
      "plugins/genshin/api.js": "export default class Api { getData() { return 1 } }",
      "plugins/ji-plugin/index.js": `
      import Api from '../genshin/api.js';
      Api.prototype.getData=function(){return 2};
      setTimeout(()=>{Api.prototype.getData=function(){return 3}},20);
      export const ok=true;
    `,
    },
    `
    await import('./plugins/ji-plugin/index.js');
    await new Promise(resolve=>setTimeout(resolve,80));
    const {default:Api}=await import('./plugins/genshin/api.js');
    console.log(JSON.stringify({value:new Api().getData(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 3)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 2)
  assert.equal(changes[0].plugin, "ji-plugin")
  assert.equal(changes[0].details.attribution, "current-plugin")
  assert.equal(changes[1].plugin, "unknown")
})

test("self import, circular dependency, top-level await and dynamic query imports keep ESM semantics", () => {
  const result = fixture(
    {
      "plugins/cycle/a.js": `
      import * as self from './a.js';
      import {b} from './b.js';
      export function a(){return 'a'+b()}
      export function own(){return self.a===a}
      await Promise.resolve();
      export const ready=true;
    `,
      "plugins/cycle/b.js": `
      import {a} from './a.js';
      export function b(){return 'b'}
      export function fromA(){return a()}
    `,
      "plugins/cycle/live.js": "export let fn=()=>1; export function change(){fn=()=>2}",
    },
    `
    const a=await import('./plugins/cycle/a.js');
    const b=await import('./plugins/cycle/b.js');
    const first=await import('./plugins/cycle/live.js?key=one');
    const second=await import('./plugins/cycle/live.js?key=two');
    first.change();audit.check('cycle');
    console.log(JSON.stringify({a:a.a(),self:a.own(),ready:a.ready,b:b.fromA(),first:first.fn(),second:second.fn(),events:auditEvents}));
  `,
  )
  assert.equal(result.a, "ab")
  assert.equal(result.self, true)
  assert.equal(result.ready, true)
  assert.equal(result.b, "ab")
  assert.equal(result.first, 2)
  assert.equal(result.second, 1)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 1)
  assert.equal(changes[0].target, "plugins/cycle/live.js#fn")
  assert.doesNotMatch(JSON.stringify(result.events), /key=one|key=two/)
})

test("getters, proxies and function toString hooks are never executed by inspection", () => {
  const result = fixture(
    {
      "plugins/getters/index.js": `
      globalThis.getterCalls=0;globalThis.proxyCalls=0;globalThis.stringCalls=0;
      export class Subject { run(){return 7} static get secret(){getterCalls++;throw Error('getter')} }
      Object.defineProperty(Subject.prototype,'hidden',{get(){getterCalls++;throw Error('getter')}});
      Subject.toString=()=>{stringCalls++;throw Error('toString')};
      export const blocked=new Proxy(function(){return 9},{ownKeys(){proxyCalls++;throw Error('proxy')},getOwnPropertyDescriptor(){proxyCalls++;throw Error('proxy')}});
    `,
    },
    `
    const {Subject,blocked}=await import('./plugins/getters/index.js');
    audit.check();audit.check();
    console.log(JSON.stringify({value:new Subject().run(),proxyValue:blocked(),getterCalls,proxyCalls,stringCalls,events:auditEvents}));
  `,
  )
  assert.equal(result.value, 7)
  assert.equal(result.proxyValue, 9)
  assert.equal(result.getterCalls, 0)
  assert.equal(result.proxyCalls, 0)
  assert.equal(result.stringCalls, 0)
  assert.equal(
    result.events.some(event => event.details?.reason === "proxy"),
    true,
  )
  assert.equal(
    result.events.some(event => event.operation === "module-function-change"),
    false,
  )
})

test("a cyclic re-export leaving its TDZ is a late baseline, not a reported hook", () => {
  const result = fixture(
    {
      "plugins/cycle/a.js": "import {b} from './b.js';export let a=()=>b();",
      "plugins/cycle/b.js": "export {a} from './a.js';export function b(){return 8}",
    },
    `
    const {a}=await import('./plugins/cycle/a.js');audit.check();
    console.log(JSON.stringify({value:a(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 8)
  assert.equal(
    result.events.some(event => event.operation === "module-function-change"),
    false,
  )
})

test("hoisted circular exports finish own initialization before baseline; later foreign hooks still report", () => {
  const result = fixture(
    {
      "plugins/cycle/a.js":
        "import './b.js';export function Constructor(){};await new Promise(resolve=>setTimeout(resolve,25));Constructor.prototype.initialized=function(){return 7};",
      "plugins/cycle/b.js": "export {Constructor} from './a.js';",
      "plugins/editor/index.js": `import {Constructor} from '../cycle/a.js';export function replacement(){return 9};Constructor.prototype.initialized=replacement;`,
    },
    `
    const {Constructor}=await import('./plugins/cycle/a.js');audit.check();
    const before=new Constructor().initialized();
    const initialChanges=auditEvents.filter(event=>event.operation==='module-function-change');
    await import('./plugins/editor/index.js');audit.check();
    console.log(JSON.stringify({before,after:new Constructor().initialized(),initialChanges,events:auditEvents}));
  `,
  )
  assert.equal(result.before, 7)
  assert.equal(result.after, 9)
  assert.deepEqual(result.initialChanges, [])
  assert.ok(result.events.some(event => event.details?.reason === "cyclic-baseline-deferred"))
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.ok(
    changes.some(event => event.target === "plugins/cycle/a.js#Constructor.prototype.initialized"),
  )
  assert.ok(changes.every(event => event.plugin === "editor" && event.action === "audit"))
})

test("only explicitly trusted function wrappers are equivalent; flags and later foreign hooks remain visible", () => {
  const result = fixture(
    {
      "plugins/subject/index.js": "export default class Subject {run(){return 1}}",
    },
    `
    const {default:Subject}=await import('./plugins/subject/index.js');
    const original=Subject.prototype.run;
    function wrapped(...args){return original.apply(this,args)}
    trustedOriginals.set(wrapped,original);Subject.prototype.run=wrapped;
    audit.check('guard');
    const wrapperChanges=auditEvents.filter(event=>event.operation==='module-function-change');
    Object.defineProperty(Subject.prototype,'run',{enumerable:true});audit.check('editor');
    const flagsChanges=auditEvents.filter(event=>event.operation==='module-function-change').length;
    Subject.prototype.run=function(){return 5};audit.check('editor');
    console.log(JSON.stringify({value:new Subject().run(),wrapperChanges,flagsChanges,events:auditEvents}));
  `,
  )
  assert.deepEqual(result.wrapperChanges, [])
  assert.equal(result.flagsChanges, 1)
  assert.equal(result.value, 5)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 2)
  assert.equal(changes[1].plugin, "editor")
})

test("telemetry/context failures do not reject module evaluation or restore a business hook", () => {
  const result = fixture(
    {
      "plugins/genshin/api.js": "export default class Api { fn(){return 1} }",
      "plugins/ji-plugin/index.js":
        "import Api from '../genshin/api.js';Api.prototype.fn=()=>5;export default Api;",
    },
    `
    const {default:Api}=await import('./plugins/ji-plugin/index.js');
    audit.check();
    console.log(JSON.stringify({value:new Api().fn(),failures:auditEmissionFailures,events:auditEvents}));
  `,
    { contextThrows: true, emitThrows: true },
  )
  assert.equal(result.value, 5)
  assert.ok(result.failures >= 1)
  assert.equal(
    result.events.some(event => event.operation === "module-function-change"),
    true,
  )
})

test("descriptor/accessor replacement and deletion are audited without invoking the getter", () => {
  const result = fixture(
    {
      "plugins/subject/index.js":
        "export default class Subject { run(){return 1} remove(){return 2} }",
    },
    `
    const {default:Subject}=await import('./plugins/subject/index.js');
    let getterCalls=0;
    Object.defineProperty(Subject.prototype,'run',{get(){getterCalls++;return ()=>4}});
    delete Subject.prototype.remove;
    Subject.prototype.added=()=>3;
    audit.check('editor');
    console.log(JSON.stringify({getterCalls,added:new Subject().added(),removed:!('remove' in Subject.prototype),events:auditEvents}));
  `,
  )
  assert.equal(result.getterCalls, 0)
  assert.equal(result.added, 3)
  assert.equal(result.removed, true)
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.deepEqual(changes.map(event => event.target.split(".").at(-1)).sort(), [
    "added",
    "remove",
    "run",
  ])
  assert.ok(changes.every(event => event.action === "audit" && event.plugin === "editor"))
})

test("CJS still runs; excluded locations and special formats are not transformed", () => {
  const result = fixture(
    {
      "plugins/legacy/index.cjs": "module.exports=function(){return 42}",
    },
    `
    const {default:legacy}=await import('./plugins/legacy/index.cjs');
    console.log(JSON.stringify({value:legacy(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 42)
  assert.ok(result.events.some(event => event.details?.reason === "unsupported-format"))
  const events = []
  const root = path.join(os.tmpdir(), "module-audit-locations")
  const audit = installModuleAudit({
    root,
    guardRoot: path.join(root, "plugins/guard"),
    emit: event => events.push(event),
  })
  try {
    for (const file of [
      "lib/core.js",
      "plugins/guard/index.js",
      "plugins/peer/node_modules/pkg/index.js",
      "plugins/../core.js",
    ]) {
      assert.equal(
        audit.instrument(pathToFileURL(path.join(root, file)).href, "module", "export const x=1"),
        undefined,
      )
    }
    for (const format of ["commonjs", "json", "wasm", undefined]) {
      assert.equal(
        audit.instrument(
          pathToFileURL(path.join(root, "plugins/peer/index.js")).href,
          format,
          "export const x=1",
        ),
        undefined,
      )
    }
    assert.equal(
      audit.instrument("data:text/javascript,export default 1", "module", "export default 1"),
      undefined,
    )
    assert.equal(audit.instrument("not-a-url", "module", "export default 1"), undefined)
    assert.ok(events.some(event => event.details.reason === "unsupported-format"))
    assert.doesNotMatch(JSON.stringify(events), /module-audit-locations|file:/)
  } finally {
    audit.close()
  }
})

test("registration/source/property quotas degrade coverage and leave business functions usable", () => {
  const events = []
  const root = path.join(os.tmpdir(), "module-audit-quotas")
  const audit = installModuleAudit({
    root,
    guardRoot: path.join(root, "plugins/guard"),
    emit: event => events.push(event),
  })
  try {
    const base = pathToFileURL(path.join(root, "plugins/peer/index.js")).href
    assert.equal(
      audit.instrument(base, "module", " ".repeat(MODULE_AUDIT_LIMITS.sourceBytes + 1)),
      undefined,
    )
    for (let index = 0; index < MODULE_AUDIT_LIMITS.modules; index++) {
      assert.equal(
        typeof audit.instrument(`${base}?private=${index}`, "module", "export const x=1"),
        "string",
      )
    }
    assert.equal(
      audit.instrument(`${base}?private=overflow`, "module", "export const x=1"),
      undefined,
    )
    assert.ok(events.some(event => event.details.reason === "module-limit"))
    assert.ok(events.some(event => event.details.reason === "source-limit"))
    assert.doesNotMatch(JSON.stringify(events), /private=|file:|module-audit-quotas/)
  } finally {
    audit.close()
  }
  assert.equal(
    audit.instrument(pathToFileURL(path.join(root, "plugins/peer/after.js")).href, "module", ""),
    undefined,
  )
  assert.doesNotThrow(() => audit.check())
  const result = fixture(
    {
      "plugins/large/index.js": `export default class Large {ok(){return 11}}; for(let n=0;n<400;n++) Large.prototype['method'+n]=()=>n`,
    },
    `const {default:Large}=await import('./plugins/large/index.js');audit.check();console.log(JSON.stringify({value:new Large().method399(),events:auditEvents}));`,
  )
  assert.equal(result.value, 399)
  assert.ok(result.events.some(event => event.details?.reason === "property-limit"))
})

test("graph limits defer uncertain exports while completed direct declarations remain observable", () => {
  const result = fixture(
    {
      "plugins/subject/index.js":
        "class Subject {run(){return 1}}; export default (()=>Subject)();",
      "plugins/own/index.js": "export default class Own {run(){return 2}}",
    },
    `
    const graph=Array.from({length:512},(_,index)=>new URL('./plugins/graph/m'+index+'.js',import.meta.url).href);
    for(let left=0;left<183;left++) for(let right=0;right<183;right++) if(left!==right) audit.resolve(graph[left],graph[right]);
    const {default:Subject}=await import('./plugins/subject/index.js');
    const {default:Own}=await import('./plugins/own/index.js');
    Subject.prototype.run=()=>6;audit.check('editor');
    Own.prototype.run=()=>8;audit.check('editor');
    console.log(JSON.stringify({value:new Subject().run(),own:new Own().run(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 6)
  assert.equal(result.own, 8)
  assert.ok(result.events.some(event => event.details?.reason === "resolution-limit"))
  const changes = result.events.filter(event => event.operation === "module-function-change")
  assert.equal(changes.length, 1)
  assert.equal(changes[0].target, "plugins/own/index.js#default.prototype.run")
  assert.doesNotMatch(JSON.stringify(result.events), /file:|guard-module-audit-/)
  const events = []
  const root = path.join(os.tmpdir(), "guard-module-graph-nodes")
  const audit = installModuleAudit({
    root,
    guardRoot: path.join(root, "plugins/guard"),
    emit: event => events.push(event),
  })
  const urls = Array.from(
    { length: MODULE_AUDIT_LIMITS.graphNodes + 1 },
    (_, index) => pathToFileURL(path.join(root, `plugins/graph/${index}.js`)).href,
  )
  try {
    for (let index = 1; index < urls.length; index++) audit.resolve(urls[index - 1], urls[index])
    assert.ok(events.some(event => event.details?.reason === "resolution-limit"))
    assert.doesNotThrow(() => audit.check())
  } finally {
    audit.close()
  }
})

for (const bridge of ["lib", "node_modules", "both", "cjs"]) {
  test(`hoisted TLA cycle through ${bridge} opaque bridges has a baseline and reports only later foreign hooks`, () => {
    const aImport =
      bridge === "node_modules"
        ? "'bridge1'"
        : bridge === "cjs"
          ? "'../../lib/bridge1.cjs'"
          : "'../../lib/bridge1.mjs'"
    const bExport = bridge === "both" ? "'bridge2'" : "'./a.js'"
    const files = {
      "plugins/cycle/a.js": `import ${aImport};export function Constructor(){};await new Promise(resolve=>setTimeout(resolve,25));Constructor.prototype.initialized=function(){return 7};`,
      "plugins/cycle/b.js": `export {Constructor} from ${bExport};`,
      "plugins/editor/index.js":
        "import {Constructor} from '../cycle/a.js';export function replacement(){return 9};Constructor.prototype.initialized=replacement;",
      ...(bridge === "cjs"
        ? { "lib/bridge1.cjs": "globalThis.bridgePromise=import('../plugins/cycle/b.js');" }
        : bridge === "node_modules"
          ? {
              "node_modules/bridge1/package.json": '{"type":"module","exports":"./index.js"}',
              "node_modules/bridge1/index.js":
                "export {Constructor} from '../../plugins/cycle/b.js';",
            }
          : { "lib/bridge1.mjs": "export {Constructor} from '../plugins/cycle/b.js';" }),
      ...(bridge === "both"
        ? {
            "node_modules/bridge2/package.json": '{"type":"module","exports":"./index.js"}',
            "node_modules/bridge2/index.js":
              "export {Constructor} from '../../plugins/cycle/a.js';",
          }
        : {}),
    }
    const result = fixture(
      files,
      `
      const {Constructor}=await import('./plugins/cycle/a.js');await globalThis.bridgePromise;audit.check();
      const before=new Constructor().initialized();
      const initialChanges=auditEvents.filter(event=>event.operation==='module-function-change');
      await import('./plugins/editor/index.js');audit.check();
      console.log(JSON.stringify({before,after:new Constructor().initialized(),initialChanges,events:auditEvents}));
    `,
    )
    assert.equal(result.before, 7)
    assert.equal(result.after, 9)
    assert.deepEqual(result.initialChanges, [])
    const changes = result.events.filter(event => event.operation === "module-function-change")
    assert.ok(
      changes.some(
        event => event.target === "plugins/cycle/a.js#Constructor.prototype.initialized",
      ),
    )
    assert.ok(
      changes.every(event => event.plugin === "editor" && event.target.startsWith("plugins/")),
    )
    assert.ok(result.events.some(event => event.details?.reason === "cyclic-baseline-deferred"))
    assert.equal(
      result.events.some(event => event.details?.reason === "resolution-limit"),
      false,
    )
  })
}

test("opaque dependency nodes do not consume audited-module registrations", () => {
  const result = fixture(
    { "plugins/subject/index.js": "export default class Subject {run(){return 1}}" },
    `
    const graph=Array.from({length:${MODULE_AUDIT_LIMITS.graphNodes - 32}},(_,index)=>new URL('./lib/bridge'+index+'.js',import.meta.url).href);
    for(let index=1;index<graph.length;index++)audit.resolve(graph[index-1],graph[index]);
    const {default:Subject}=await import('./plugins/subject/index.js');
    Subject.prototype.run=()=>6;audit.check('editor');
    console.log(JSON.stringify({value:new Subject().run(),events:auditEvents}));
  `,
  )
  assert.equal(result.value, 6)
  assert.equal(
    result.events.some(event => event.details?.reason === "resolution-limit"),
    false,
  )
  assert.ok(
    result.events.some(
      event => event.operation === "module-function-change" && event.plugin === "editor",
    ),
  )
})
