import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import { shutdownBootstrapResources } from "../dist/host/bootstrap/shutdown.js"

function redisClient(process, calls = []) {
  const client = new EventEmitter()
  client.process = process
  client.isOpen = true
  client.save = async () => calls.push("save")
  client.quit = async () => {
    calls.push("quit")
    client.isOpen = false
  }
  client.disconnect = async () => {
    calls.push("disconnect")
    client.isOpen = false
  }
  return client
}

async function withOwnedProcess(check) {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
    windowsHide: true,
  })
  await once(child, "spawn")
  try {
    await check(child)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill("SIGKILL")
      await exited
    }
  }
}

test("bootstrap waits for the actual owned service exit after the core kill returns", async () => {
  await withOwnedProcess(async child => {
    const calls = []
    await shutdownBootstrapResources(
      {
        exitEvent: async reason => calls.push(reason),
        redisExit: async () => {
          calls.push("redis")
          return child.kill()
        },
      },
      redisClient(child, calls),
      3000,
    )
    assert.deepEqual(calls, ["restart", "save", "quit", "redis"])
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  })
})

test("a failing business exit hook still cleans up the owned Redis", async () => {
  await withOwnedProcess(async child => {
    const failure = new Error("business exit failed")
    let redisCalls = 0
    await assert.rejects(
      shutdownBootstrapResources(
        {
          exitEvent: async () => {
            throw failure
          },
          redisExit: async () => {
            redisCalls++
            child.kill()
          },
        },
        redisClient(child),
        3000,
      ),
      error => error === failure,
    )
    assert.equal(redisCalls, 1)
    assert.ok(child.exitCode !== null || child.signalCode !== null)
  })
})

test("a stalled exit hook cannot consume the service cleanup budget", async () => {
  const calls = []
  await assert.rejects(
    shutdownBootstrapResources(
      {
        exitEvent: () => new Promise(() => {}),
        redisExit: async () => assert.fail("external Redis must not be stopped"),
      },
      redisClient(undefined, calls),
      60,
    ),
    /退出钩子超时/,
  )
  assert.deepEqual(calls, ["quit"])
})

test("a service still alive after core cleanup rejects the handoff", async () => {
  await withOwnedProcess(async child => {
    await assert.rejects(
      shutdownBootstrapResources(
        { exitEvent: async () => {}, redisExit: async () => true },
        redisClient(child),
        60,
      ),
      /Redis 清理超时/,
    )
  })
})

test("an externally managed Redis has no owned child to wait for or signal", async () => {
  const calls = []
  await shutdownBootstrapResources(
    { exitEvent: async () => {}, redisExit: async () => assert.fail("external Redis stop") },
    redisClient(undefined, calls),
    1000,
  )
  assert.deepEqual(calls, ["quit"])
})

test("raw exit hooks flush before external Redis cleanup without calling Bot.exit", async () => {
  const bot = new EventEmitter()
  const calls = []
  bot.exit = () => assert.fail("Bot.exit must not stop the bootstrap process")
  bot.once("exit", async reason => calls.push(reason))
  await shutdownBootstrapResources(bot, redisClient(undefined, calls), 1000)
  assert.deepEqual(calls, ["restart", "quit"])
  assert.equal(bot.listenerCount("exit"), 0)
})

test("closing removes only the core reconnect listeners and stops SDK reconnect synchronously", async () => {
  const client = redisClient()
  let coreReconnects = 0,
    sdkReconnects = 0,
    otherErrors = 0
  const coreError = () => coreReconnects++
  const otherError = () => otherErrors++
  client.class = { onerror: coreError }
  client.once("error", coreError)
  client.on("error", coreError)
  client.on("error", otherError)
  const failure = new Error("connection failed while quitting")
  client.quit = async () => {
    client.emit("error", failure)
    if (client.isOpen) sdkReconnects++
    throw failure
  }
  await assert.rejects(
    shutdownBootstrapResources({ exitEvent: async () => {} }, client, 1000),
    error => error === failure,
  )
  assert.equal(coreReconnects, 0)
  assert.equal(sdkReconnects, 0)
  assert.equal(otherErrors, 1)
  assert.ok(client.listeners("error").includes(otherError))
  assert.equal(client.listeners("error").includes(coreError), false)
})

test("persistence failure rejects handoff without calling core stop on changed data", async () => {
  await withOwnedProcess(async child => {
    const client = redisClient(child)
    const failure = new Error("SAVE failed")
    client.save = async () => {
      throw failure
    }
    await assert.rejects(
      shutdownBootstrapResources(
        { exitEvent: async () => {}, redisExit: async () => assert.fail("SAVE was not confirmed") },
        client,
        1000,
      ),
      error => error === failure,
    )
    assert.equal(client.isOpen, false)
  })
})

test("an unconfirmed QUIT deadline never stops an external server", async () => {
  const client = redisClient()
  client.quit = () => {
    client.isOpen = false
    return new Promise(() => {})
  }
  await assert.rejects(
    shutdownBootstrapResources(
      { exitEvent: async () => {}, redisExit: async () => assert.fail("external service stop") },
      client,
      60,
    ),
    /Redis 清理超时/,
  )
})

test("replacement of the original client rejects handoff before operating on the new client", async () => {
  await withOwnedProcess(async child => {
    const client = redisClient(child)
    const replacement = redisClient()
    replacement.quit = async () => assert.fail("new client must remain untouched")
    await assert.rejects(
      shutdownBootstrapResources(
        { exitEvent: async () => {}, redisExit: async () => assert.fail("client was replaced") },
        client,
        1000,
        () => replacement,
      ),
      /清理期间 Redis 客户端已变化/,
    )
    assert.equal(replacement.isOpen, true)
  })
})

test("an external client replaced while QUIT is pending cannot confirm handoff", async () => {
  const original = redisClient()
  const replacement = redisClient()
  let current = original
  original.quit = async () => {
    original.isOpen = false
    current = replacement
  }
  await assert.rejects(
    shutdownBootstrapResources({ exitEvent: async () => {} }, original, 1000, () => current),
    /清理期间 Redis 客户端已变化/,
  )
  assert.equal(replacement.isOpen, true)
})

test("a new service attached during external QUIT cannot confirm handoff", async () => {
  const client = redisClient()
  const service = {}
  client.quit = async () => {
    client.isOpen = false
    client.process = service
  }
  await assert.rejects(
    shutdownBootstrapResources({ exitEvent: async () => {} }, client, 1000),
    /清理期间 Redis 服务已变化/,
  )
  assert.equal(client.process, service)
})
