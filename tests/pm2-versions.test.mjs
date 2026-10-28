import assert from "node:assert/strict"
import test from "node:test"
import { isSupportedPm2Version } from "../dist/pm2/versions.js"

test("PM2 版本只设下限：>= 5.0.0，含更高版本的预发布号", () => {
  for (const value of [
    "5.0.0",
    "5.4.3",
    "6.0.5",
    "6.0.14",
    "6.0.15",
    "6.1.0",
    "7.0.2",
    "7.0.3",
    "7.0.4",
    "7.1.0",
    "8.0.0",
    "20.0.0",
    "7.1.0+vendor.1",
    "7.0.3-alpha.1",
    "6.0.15-rc.1",
    "6.0.14-rc.1",
    "5.4.3-beta.1",
    "8.0.0-beta.2+build.5",
  ])
    assert.equal(isSupportedPm2Version(value), true)
  for (const value of [
    undefined,
    null,
    7,
    {},
    ["7.0.3"],
    "",
    "4.5.6",
    "4.99.99",
    "5.0.0-rc.1",
    "06.0.14",
    "6.00.14",
    "6.0.014",
    "7.1.0+",
    "7.1.0+bad..build",
    "7.0.3-",
    "7.0.3-bad..pre",
    "v7.0.3",
    " 7.0.3",
    "7.0.3 ",
    "7.0.3\n",
  ])
    assert.equal(isSupportedPm2Version(value), false)
})
