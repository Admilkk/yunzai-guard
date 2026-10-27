import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href

test("private binding guard blocks bypass capabilities and preserves public modules", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import fs from "node:fs";
        import {createHash} from "node:crypto";
        import {createRequire} from "node:module";
        import {installBindingGuard} from ${JSON.stringify(moduleUrl("protect/bindings"))};
        import {seal,refuse} from ${JSON.stringify(moduleUrl("protect/objects"))};
        installBindingGuard(seal,refuse);
        const denied=fn=>assert.throws(fn,error=>error.code==="ERR_GUARD_SELF_PROTECTION");
        for(const name of ["fs","inspector","contextify","process_wrap","spawn_sync","tcp_wrap","pipe_wrap","stream_wrap","buffer"])
          denied(()=>process.binding(name));
        denied(()=>process.binding({toString(){return "fs"}}));
        denied(()=>process._linkedBinding("fs"));
        denied(()=>{process.binding=()=>({})});
        assert.equal(process.binding("util").isDate(new Date()),true);
        assert.equal(typeof process.binding("uv").errname,"function");
        assert.equal(typeof process.binding("constants").fs.O_RDONLY,"number");
        assert.equal(typeof process.binding("natives").fs,"string");
        assert.equal(process.getBuiltinModule("fs"),fs);
        assert.equal(createRequire(import.meta.url)("node:fs"),fs);
        assert.equal(fs.statSync(process.execPath).isFile(),true);
        assert.equal(createHash("sha256").update("ok").digest("hex").length,64);
      `,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  )
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
})

test("exposed Node internals are rejected before protection starts", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--expose-internals",
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        import {assertNoInternals} from ${JSON.stringify(moduleUrl("protect/bindings"))};
        assert.throws(assertNoInternals,/--expose-internals/);
      `,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  )
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
})

test("diagnostic reports cannot overwrite protected paths or change their automatic destination", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-report-"))
  const protectedRoot = path.join(directory, "guard")
  const sentinel = path.join(protectedRoot, "keep.json")
  fs.mkdirSync(protectedRoot)
  fs.mkdirSync(path.join(directory, "reports"))
  fs.writeFileSync(sentinel, "unchanged")
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import fs from "node:fs";
          import {installReportGuard} from ${JSON.stringify(moduleUrl("protect/reports"))};
          import {seal,refuse} from ${JSON.stringify(moduleUrl("protect/objects"))};
          installReportGuard({roots:[${JSON.stringify(protectedRoot)}],seal,deny:refuse});
          const denied=fn=>assert.throws(fn,error=>error.code==="ERR_GUARD_SELF_PROTECTION");
          denied(()=>process.report.writeReport(${JSON.stringify(sentinel)}));
          denied(()=>process.report.writeReport("guard/keep.json"));
          denied(()=>{process.report.directory="guard"});
          denied(()=>{process.report.filename="guard/keep.json"});
          process.report.directory="reports";
          denied(()=>{process.report.filename="../guard/keep.json"});
          process.report.filename="normal.json";
          assert.equal(process.report.writeReport(),"normal.json");
          assert.equal(process.report.writeReport(new URL("file:///ignored")),"normal.json");
          assert.equal(process.report.writeReport(new Uint8Array()),"normal.json");
          assert.equal(JSON.parse(fs.readFileSync("reports/normal.json","utf8")).header.processId,process.pid);
          process.report.directory="";
          process.report.reportOnUncaughtException=true;
          const guardedChdir=process.chdir;
          process.chdir=function(...args){return Reflect.apply(guardedChdir,process,args)};
          Object.setPrototypeOf(process.chdir,guardedChdir);
          const before=process.cwd();
          denied(()=>process.chdir("guard"));
          assert.equal(process.cwd(),before);
          process.report.reportOnUncaughtException=false;
          process.chdir("reports");
          assert.equal(process.cwd(),before+${JSON.stringify(path.sep)}+"reports");
          process.chdir(before);
          denied(()=>{process.report.writeReport=()=>"changed"});
          assert.throws(()=>{process.report.directory=new Uint8Array()},error=>error.code==="ERR_INVALID_ARG_TYPE");
        `,
      ],
      { cwd: directory, encoding: "utf8", windowsHide: true, timeout: 15000 },
    )
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged")
  } finally {
    assert.equal(path.dirname(directory), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
