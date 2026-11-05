import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

// 在独立 Linux 测试环境安装 systeminformation、puppeteer-core 后启用；浏览器使用真实系统入口。
const enabled = process.platform === "linux" && process.env.GUARD_TEST_LINUX_PLUGIN_COMPAT === "1"
test(
  "Linux yenai 系统信息与 Puppeteer 浏览器入口默认可运行",
  {
    skip: enabled ? false : "requires Linux, systeminformation, puppeteer-core and a browser",
    timeout: 90000,
  },
  () => {
    const runtime = new URL("../dist/runtime/index.js", import.meta.url).href
    const config = new URL("../dist/config/index.js", import.meta.url).href
    const dependencyRoot = process.env.GUARD_TEST_LINUX_PLUGIN_DEPENDENCIES
    const browser = process.env.GUARD_TEST_BROWSER ?? "/usr/bin/chromium"
    assert.ok(
      dependencyRoot,
      "GUARD_TEST_LINUX_PLUGIN_DEPENDENCIES must name an isolated package.json",
    )
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {installRuntime} from ${JSON.stringify(runtime)};
    import {parseSettings} from ${JSON.stringify(config)};
    const events=[];
    installRuntime({settings:parseSettings({}),identity:{id:'linux-plugin-compat',generation:1,kind:'yunzai',pid:process.pid,originPlugin:'yenai-plugin',observability:'js-entrypoints'},emit:event=>events.push(event)});
    const require=createRequire(${JSON.stringify(dependencyRoot)});
    const si=require('systeminformation');
    for(const name of ['osInfo','cpu','networkInterfaces','currentLoad'])assert.ok(await si[name](),name);
    const browser=await require('puppeteer-core').launch({executablePath:${JSON.stringify(browser)},headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],timeout:30000});
    try{
      const page=await browser.newPage();
      await page.setContent('<html><body>guard-compatibility</body></html>');
      assert.ok((await page.screenshot()).length>1000);
    }finally{await browser.close();}
    assert.deepEqual(events.filter(event=>event.action==='deny'),[]);
  `,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 80000 },
    )
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
  },
)
