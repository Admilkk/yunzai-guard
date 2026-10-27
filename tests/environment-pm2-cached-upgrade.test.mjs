import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { createCachedUpgradeFixture } from "./pm2-cached-upgrade-fixture.mjs"
const enabled =
  process.env.GUARD_TEST_PM2_CACHED_UPGRADE === "1" && ["win32", "linux"].includes(process.platform)
const packages = enabled
  ? process.env.GUARD_TEST_PM2_CACHED_PACKAGES
    ? JSON.parse(process.env.GUARD_TEST_PM2_CACHED_PACKAGES)
    : [process.env.GUARD_TEST_PM2_PACKAGE]
  : ["disabled"]
assert.ok(Array.isArray(packages) && packages.length > 0 && packages.length <= 3)
let cleanupUncertain = false
for (const pm2Root of packages)
  test(
    `Real PM2 R26 cached namespace and peer → frozen candidate (${pm2Root})`,
    {
      skip: enabled ? false : "requires GUARD_TEST_PM2_CACHED_UPGRADE=1 and explicit frozen inputs",
      timeout: 1200000,
    },
    async context => {
      if (cleanupUncertain) {
        context.skip("Previous owned cleanup was not confirmed; remaining case not run")
        return
      }
      assert.ok(path.isAbsolute(pm2Root))
      let fixture
      try {
        fixture = await createCachedUpgradeFixture({
          pm2Root,
          nodePath: process.env.GUARD_TEST_PM2_NODE || process.execPath,
          oldGuardSource: process.env.GUARD_TEST_PM2_CACHED_OLD_SOURCE,
          newGuardSource: process.env.GUARD_TEST_GUARD_SOURCE,
          newManifest: process.env.GUARD_TEST_PM2_CACHED_NEW_MANIFEST,
          newManifestSha256: process.env.GUARD_TEST_PM2_CACHED_NEW_SHA256,
          signal: context.signal,
        })
        context.diagnostic(`Evidence: ${fixture.stateRoot}`)
        await fixture.run()
        assert.equal(fixture.report.actions.filter(row => row.kind === "target").length, 20)
        assert.equal(fixture.report.actions.filter(row => row.kind === "old-peer").length, 2)
        assert.equal(fixture.report.cleanup.confirmed, true)
      } finally {
        if (fixture?.report.spawnedDaemonPid) {
          const cleanup = fixture.report.cleanup,
            diagnostics = fixture.report.cleanupDiagnostics
          if (
            cleanup?.confirmed !== true ||
            cleanup.scopeObservationComplete !== true ||
            !Array.isArray(diagnostics?.censusErrors) ||
            diagnostics.censusErrors.length !== 0 ||
            !Array.isArray(diagnostics.scopeErrors) ||
            diagnostics.scopeErrors.length !== 0
          )
            cleanupUncertain = true
        }
        if (fixture) context.diagnostic(`Evidence: ${fixture.stateRoot}`)
      }
    },
  )
