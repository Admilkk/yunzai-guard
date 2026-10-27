import assert from "node:assert/strict"
import vm from "node:vm"
import test from "node:test"
import {
  assertPm2AgentModule,
  assertPm2InspectorSessionModule,
  pm2AgentRegistrationExpression,
  pm2InspectorPreparationExpression,
} from "../dist/pm2/agent-protocol.js"

const agentPath = "/private/guard/dist/pm2/agent-v2.js"
const transportPath = "/private/guard/dist/pm2/inspector-session-v1.js"
const capabilities = () =>
  Object.freeze({ agentProtocol: 2, bootstrapExitBarrier: 1, cachedRegistryUpgrade: 1 })

function daemonContext(agentSource) {
  const context = vm.createContext({})
  vm.runInContext(
    `globalThis.application={pid:321,launcher:'app.js',args:[]};
     globalThis.registrationCalls=0;globalThis.getterCalls=0;globalThis.loadPaths=[];
     globalThis.modules=Object.create(null);
     modules[${JSON.stringify(agentPath)}]=()=>(${agentSource});
     globalThis.process={argv:['node','/private/pm2/lib/Daemon.js'],getBuiltinModule(name){
       if(name!=='module')throw new Error('Unexpected builtin');
       return {createRequire(entry){if(entry!==process.argv[1])throw new Error('Wrong require base');
         return path=>{loadPaths.push(path);if(!modules[path])throw new Error('Missing module');return modules[path]()}}}
     }};`,
    context,
  )
  return context
}

test("cached agents without the complete static ABI cannot mutate the selected application", async () => {
  const register =
    "registerPm2Application(){registrationCalls++;application.launcher='old-launcher.js';application.args.push('handoff')}"
  for (const capabilitySource of [
    "",
    "pm2AgentCapabilities:Object.freeze({agentProtocol:1,bootstrapExitBarrier:1,cachedRegistryUpgrade:1}),",
    "pm2AgentCapabilities:Object.freeze({agentProtocol:2,bootstrapExitBarrier:1}),",
    "pm2AgentCapabilities:Object.freeze({agentProtocol:2,bootstrapExitBarrier:0,cachedRegistryUpgrade:1}),",
    "pm2AgentCapabilities:{agentProtocol:2,bootstrapExitBarrier:1,cachedRegistryUpgrade:1},",
    "get pm2AgentCapabilities(){getterCalls++;throw new Error('Getter must not execute')},",
  ]) {
    const context = daemonContext(`{${capabilitySource}${register}}`)
    const before = vm.runInContext("JSON.stringify(application)", context)
    await assert.rejects(
      vm.runInContext(pm2AgentRegistrationExpression(agentPath, { pid: 321 }), context),
      /PM2 代理协议缺失或不兼容/,
    )
    assert.equal(context.registrationCalls, 0)
    assert.equal(context.getterCalls, 0)
    assert.equal(vm.runInContext("JSON.stringify(application)", context), before)
  }
})

test("ABI validation refuses inherited exports and capability accessors without executing them", () => {
  let getterCalls = 0
  const valid = {
    pm2AgentCapabilities: capabilities(),
    registerPm2Application() {},
  }
  assert.doesNotThrow(() => assertPm2AgentModule(valid))
  const nullPrototype = Object.freeze(
    Object.assign(Object.create(null), {
      agentProtocol: 2,
      bootstrapExitBarrier: 1,
      cachedRegistryUpgrade: 1,
    }),
  )
  assert.doesNotThrow(() => assertPm2AgentModule({ ...valid, pm2AgentCapabilities: nullPrototype }))
  const accessor = Object.freeze({
    agentProtocol: 2,
    get bootstrapExitBarrier() {
      getterCalls++
      return 1
    },
    cachedRegistryUpgrade: 1,
  })
  const getterNamespace = {
    pm2AgentCapabilities: capabilities(),
    get registerPm2Application() {
      getterCalls++
      return () => {}
    },
  }
  for (const value of [
    null,
    Object.create(valid),
    { pm2AgentCapabilities: capabilities(), ...Object.create(valid) },
    { ...valid, pm2AgentCapabilities: accessor },
    { ...valid, pm2AgentCapabilities: Object.freeze({ ...capabilities(), future: 1 }) },
    {
      ...valid,
      pm2AgentCapabilities: Object.freeze({ ...capabilities(), [Symbol("hidden")]: 1 }),
    },
    getterNamespace,
  ])
    assert.throws(() => assertPm2AgentModule(value), /PM2 代理协议缺失或不兼容，未执行登记/)
  assert.equal(getterCalls, 0)
})

test("the serialized check runs in the daemon realm before the versioned entry registers", async () => {
  const context = daemonContext(`{
    pm2AgentCapabilities:Object.freeze({agentProtocol:2,bootstrapExitBarrier:1,cachedRegistryUpgrade:1}),
    registerPm2Application(request){registrationCalls++;return {request,once:registrationCalls}}
  }`)
  vm.runInContext(
    "modules['/private/guard/dist/pm2-daemon.js']=()=>{throw new Error('Cached stable entry was used')}",
    context,
  )
  const request = { pid: 321, root: '中文 path ");application.launcher="injected";//\n' }
  const reply = await vm.runInContext(pm2AgentRegistrationExpression(agentPath, request), context)
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { request, once: 1 })
  assert.equal(context.registrationCalls, 1)
  assert.equal(context.application.launcher, "app.js")
  assert.deepEqual(Array.from(context.loadPaths), [agentPath])
})

test("owned Inspector cleanup is prepared independently before an incompatible agent is loaded", async () => {
  const context = daemonContext("{registerPm2Application(){registrationCalls++}}")
  vm.runInContext(
    `globalThis.endpointOpen=true;globalThis.prepared=0;
     modules[${JSON.stringify(transportPath)}]=()=>({
       pm2InspectorSessionProtocol:1,
       preparePm2InspectorClose(request){prepared++;globalThis.closeOwned=nonce=>{
         if(nonce!==request.nonce)throw new Error('Wrong cleanup nonce');endpointOpen=false;
       }}
     });`,
    context,
  )
  vm.runInContext(
    pm2InspectorPreparationExpression(transportPath, { nonce: "private-cleanup-nonce" }),
    context,
  )
  await assert.rejects(
    vm.runInContext(pm2AgentRegistrationExpression(agentPath, { pid: 321 }), context),
    /PM2 代理协议缺失或不兼容/,
  )
  assert.equal(context.prepared, 1)
  assert.equal(context.registrationCalls, 0)
  assert.equal(context.endpointOpen, true)
  vm.runInContext("closeOwned('private-cleanup-nonce')", context)
  assert.equal(context.endpointOpen, false)
  assert.deepEqual(Array.from(context.loadPaths), [transportPath, agentPath])
})

test("registration import failure leaves the separately prepared cleanup handler usable", async () => {
  const context = daemonContext("{}")
  vm.runInContext(
    `globalThis.closed=false;
     modules[${JSON.stringify(transportPath)}]=()=>({pm2InspectorSessionProtocol:1,
       preparePm2InspectorClose(){globalThis.closeOwned=()=>{closed=true}}});
     delete modules[${JSON.stringify(agentPath)}];`,
    context,
  )
  vm.runInContext(pm2InspectorPreparationExpression(transportPath, {}), context)
  await assert.rejects(
    vm.runInContext(pm2AgentRegistrationExpression(agentPath, {}), context),
    /Missing module/,
  )
  vm.runInContext("closeOwned()", context)
  assert.equal(context.closed, true)
  assert.equal(context.registrationCalls, 0)
})

test("incompatible cleanup transports never invoke preparation or registration", () => {
  let calls = 0
  const prepare = () => calls++
  const valid = { pm2InspectorSessionProtocol: 1, preparePm2InspectorClose: prepare }
  assert.doesNotThrow(() => assertPm2InspectorSessionModule(valid))
  for (const value of [
    null,
    {},
    Object.create(valid),
    { ...valid, pm2InspectorSessionProtocol: 2 },
    {
      preparePm2InspectorClose: prepare,
      get pm2InspectorSessionProtocol() {
        calls++
        return 1
      },
    },
    {
      pm2InspectorSessionProtocol: 1,
      get preparePm2InspectorClose() {
        calls++
        return prepare
      },
    },
  ])
    assert.throws(
      () => assertPm2InspectorSessionModule(value),
      /PM2 Inspector 清理通道缺失或不兼容/,
    )
  assert.equal(calls, 0)

  const context = daemonContext("{registerPm2Application(){registrationCalls++}}")
  vm.runInContext(
    `globalThis.prepared=0;modules[${JSON.stringify(transportPath)}]=()=>({
       pm2InspectorSessionProtocol:0,preparePm2InspectorClose(){prepared++}});`,
    context,
  )
  assert.throws(
    () => vm.runInContext(pm2InspectorPreparationExpression(transportPath, {}), context),
    /PM2 Inspector 清理通道缺失或不兼容/,
  )
  assert.equal(context.prepared, 0)
  assert.equal(context.registrationCalls, 0)
  assert.deepEqual(Array.from(context.loadPaths), [transportPath])
})
