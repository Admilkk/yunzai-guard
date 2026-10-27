import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("玖璃聚合仅导出受限插件 API，业务基类不按 Guard 自有函数冻结", () => {
  const source = `
    import assert from "node:assert/strict";
    import {installNativeCoreApi,installNativeCoreLoaderFacade,nativeCoreApi} from ${JSON.stringify(new URL("../dist/native-sandbox/core-loader-guest.js", import.meta.url).href)};
    import {protectObjects} from ${JSON.stringify(new URL("../dist/protect/objects.js", import.meta.url).href)};
    class Base { reply(){return "original"} }
    const loader=Object.freeze({name:"isolated-loader"});
    const values={BasePlugin:Base,cfg:{local:true}};
    installNativeCoreLoaderFacade(loader);
    installNativeCoreApi(values);
    values.BasePlugin=()=>"changed";
    const events=[];
    protectObjects(event=>events.push(event));
    const api=await import(${JSON.stringify(new URL("../dist/native-sandbox/core-api-guest.js", import.meta.url).href)});
    assert.equal(api.PluginsLoader,loader);
    assert.equal(api.BasePlugin,Base);
    assert.equal(api.cfg.local,true);
    let getterReads=0;
    const poisoned={get BasePlugin(){getterReads++;throw new Error("setter read untrusted input")}};
    for(let attempt=0;attempt<2;attempt++) {
      assert.throws(()=>installNativeCoreLoaderFacade({priority:[]}),{code:"ERR_GUARD_SELF_PROTECTION"});
      assert.throws(()=>installNativeCoreApi(poisoned),{code:"ERR_GUARD_SELF_PROTECTION"});
    }
    assert.equal(getterReads,0);
    assert.equal((await import(${JSON.stringify(new URL("../dist/native-sandbox/core-loader-guest.js", import.meta.url).href)})).default,loader);
    assert.equal(nativeCoreApi().BasePlugin,Base);
    assert.equal(api.PluginsLoader,loader);
    assert.equal(api.BasePlugin,Base);
    assert.equal(events.filter(event=>event.kind==="self-protection"&&event.action==="deny").length,4);
    for(const name of ["start","JiuLiBot","Redis","redisInit","injectGlobals","injectRedis"])
      assert.equal(name in api,false,name);
    class Business extends api.BasePlugin { reply(){return "business"} }
    assert.equal(new Business().reply(),"business");
    Base.prototype.reply=()=>"plugin-copy";
    assert.equal(new Base().reply(),"plugin-copy");
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
})
