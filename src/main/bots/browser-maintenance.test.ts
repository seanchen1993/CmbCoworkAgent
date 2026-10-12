import { afterEach, expect, it } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import {
  link,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotHostLock } from "./host-lock"
import {
  executeBotBrowserMaintenance as execute,
  listBotBrowserCheckpoints as list
} from "./browser-maintenance"
import type { BotBrowserCheckpoint } from "../../shared/bot-browser-maintenance"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-browser-maintenance-")))
  roots.push(root)
  const profile = join(root, "browser-profile"),
    value = join(profile, "Default", "Preferences")
  await mkdir(join(profile, "Default"), { recursive: true })
  await writeFile(value, "browser-before")
  await writeFile(join(root, "project.txt"), "project-content")
  const store = new BotStore(join(root, "bots.sqlite"))
  const bot = store.createBot({ nonce: "create", name: "Browser maintenance" })
  const run = store.send({ nonce: "send", conversationId: bot.conversationId, text: "queued work" })
    .runIds[0]
  store.db.run("INSERT INTO bot_browser_sessions VALUES(?,?,?)", [bot.bot.id, "{}", Date.now()])
  store.close()
  return { root, profile, value, bot, run }
}
const selection = (value: BotBrowserCheckpoint) => ({ id: value.id, sha256: value.sha256 })
async function create(root: string) {
  return (await execute(root, { action: "create", nonce: randomUUID() })).checkpoint!
}

it.each(["changed", "added", "removed"])(
  "refuses publishing a profile whose source was %s after copying",
  async (change) => {
    const f = await fixture(),
      nonce = randomUUID()
    await expect(
      execute(f.root, { action: "create", nonce }, async (step) => {
        if (step !== "copied") return
        if (change === "changed") await writeFile(f.value, "browser-edited")
        if (change === "added") await writeFile(join(f.profile, "Default", "Added"), "new bytes")
        if (change === "removed") await rm(f.value)
      })
    ).rejects.toThrow("保存期间")
    expect(await list(f.root)).toEqual([])
    // An unsuccessful capture is retryable with the same nonce.
    expect((await execute(f.root, { action: "create", nonce })).checkpoint?.id).toBe(nonce)
  }
)

it("refuses a new checkpoint copied from another Host on the same OS and browser", async () => {
  const source = await fixture(),
    target = await fixture(),
    checkpoint = await create(source.root)
  await create(target.root)
  await cp(
    join(source.root, "browser-maintenance/checkpoints", checkpoint.id),
    join(target.root, "browser-maintenance/checkpoints", checkpoint.id),
    { recursive: true }
  )
  await expect(
    execute(target.root, {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: selection(checkpoint)
    })
  ).rejects.toThrow("不属于")
  expect(await readFile(target.value, "utf8")).toBe("browser-before")
})

it("continues to restore sealed legacy format-one checkpoints", async () => {
  const f = await fixture(),
    checkpoint = await create(f.root),
    legacyId = randomUUID(),
    root = join(f.root, "browser-maintenance/checkpoints", legacyId)
  await cp(join(f.root, "browser-maintenance/checkpoints", checkpoint.id), root, {
    recursive: true
  })
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
  manifest.format = 1
  manifest.id = legacyId
  delete manifest.originId
  const bytes = JSON.stringify(manifest)
  await writeFile(join(root, "manifest.json"), bytes)
  await writeFile(f.value, "current-browser")
  await execute(f.root, {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: {
      id: legacyId,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  })
  expect(await readFile(f.value, "utf8")).toBe("browser-before")
})

it("restores only the profile, preserves task evidence, saves the displaced state and reconciles lost replies", async () => {
  const { root, value, run } = await fixture()
  const checkpoint = await create(root)
  expect(checkpoint.files).toBe(1)
  await writeFile(value, "browser-after")
  const request = {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: selection(checkpoint)
  } as const
  const result = await execute(root, request)
  expect(await readFile(value, "utf8")).toBe("browser-before")
  expect(
    await readFile(
      join(
        root,
        "browser-maintenance/checkpoints",
        result.safetyCheckpoint!.id,
        "profile/Default/Preferences"
      ),
      "utf8"
    )
  ).toBe("browser-after")
  expect(await readFile(join(root, "project.txt"), "utf8")).toBe("project-content")
  const store = new BotStore(join(root, "bots.sqlite"))
  try {
    expect(store.getRun(run).status).toBe("queued")
    expect(store.db.exec("SELECT * FROM bot_browser_sessions")[0].values).toEqual([])
    expect(
      store.db.exec("SELECT * FROM bot_events WHERE kind='computer.replaced'")[0].values
    ).toHaveLength(1)
  } finally {
    store.close()
  }
  await writeFile(value, "new-activity-after-restore")
  expect(await execute(root, request)).toEqual(result)
  expect(await readFile(value, "utf8")).toBe("new-activity-after-restore")
  expect(await list(root)).toHaveLength(2)
  await expect(execute(root, { action: "reset", nonce: request.nonce })).rejects.toThrow("标识")
})

it("resets into an empty dedicated profile and allows restoring the automatic safety checkpoint", async () => {
  const { root, value } = await fixture()
  const result = await execute(root, { action: "reset", nonce: randomUUID() })
  await expect(readFile(value)).rejects.toMatchObject({ code: "ENOENT" })
  expect(result.safetyCheckpoint?.reason).toBe("before-reset")
  await execute(root, {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: selection(result.safetyCheckpoint!)
  })
  expect(await readFile(value, "utf8")).toBe("browser-before")
})

it.each(["journal", "old", "next", "database", "receipt"])(
  "recovers an interruption after %s without repeating the replacement or losing the safety copy",
  async (step) => {
    const { root, value } = await fixture()
    const checkpoint = await create(root)
    await writeFile(value, "latest-before-crash")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: selection(checkpoint)
    } as const
    await expect(
      execute(root, request, (at) => {
        if (at === step) throw new Error("power-loss")
      })
    ).rejects.toThrow("power-loss")
    await execute(root, request)
    expect(await readFile(value, "utf8")).toBe("browser-before")
    expect(await list(root)).toHaveLength(2)
    const store = new BotStore(join(root, "bots.sqlite"))
    try {
      expect(
        store.db.exec("SELECT * FROM bot_events WHERE kind='computer.replaced'")[0].values
      ).toHaveLength(1)
    } finally {
      store.close()
    }
    await expect(readFile(join(root, "browser-maintenance/pending.json"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  }
)

it("rejects corrupt bytes and changed selections before modifying the current profile", async () => {
  const { root, value } = await fixture()
  const checkpoint = await create(root)
  const input = { action: "restore", nonce: randomUUID(), checkpoint: selection(checkpoint) }
  await writeFile(value, "current-profile")
  await writeFile(
    join(root, "browser-maintenance/checkpoints", checkpoint.id, "profile/Default/Preferences"),
    "corrupt"
  )
  await expect(execute(root, input)).rejects.toThrow("大小不匹配")
  await expect(
    execute(root, { ...input, checkpoint: { ...input.checkpoint, sha256: "0".repeat(64) } })
  ).rejects.toThrow("已变化")
  expect(await readFile(value, "utf8")).toBe("current-profile")
  expect(await list(root)).toHaveLength(1)
})

it("refuses live ownership, path injection and linked profiles", async () => {
  const { root, profile, value } = await fixture()
  const input = { action: "reset", nonce: randomUUID() }
  const lock = BotHostLock.acquire(root)!
  try {
    await expect(execute(root, input)).rejects.toThrow("仍在运行")
  } finally {
    lock.release()
  }
  await expect(execute(root, { ...input, path: root })).rejects.toThrow()
  await expect(
    execute(root, {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: "../outside", sha256: "0".repeat(64) }
    })
  ).rejects.toThrow()
  const outside = join(root, "unrelated-browser")
  await mkdir(outside)
  await writeFile(join(outside, "important"), "untouched")
  await symlink(outside, join(profile, "linked"), process.platform === "win32" ? "junction" : "dir")
  await expect(execute(root, input)).rejects.toThrow("符号链接")
  expect(await readFile(value, "utf8")).toBe("browser-before")
  expect(await readFile(join(outside, "important"), "utf8")).toBe("untouched")
})

it("blocks an orphan browser lock and returns a create receipt without duplicate snapshots", async () => {
  const { root, profile } = await fixture()
  await writeFile(join(profile, "SingletonLock"), "still-running")
  const input = { action: "create", nonce: randomUUID() }
  await expect(execute(root, input)).rejects.toThrow("进程锁")
  await rm(join(profile, "SingletonLock"))
  const first = await execute(root, input)
  expect(await execute(root, input)).toEqual(first)
  await execute(root, { action: "delete", checkpoint: selection(first.checkpoint!) })
  await execute(root, { action: "delete", checkpoint: selection(first.checkpoint!) })
  expect(await list(root)).toEqual([])
})

it("refuses corrupted recovery staging after interruption and leaves the current profile intact", async () => {
  const { root, value } = await fixture()
  const checkpoint = await create(root)
  await writeFile(value, "current-state")
  const input = { action: "restore", nonce: randomUUID(), checkpoint: selection(checkpoint) }
  await expect(
    execute(root, input, (step) => {
      if (step === "journal") throw new Error("interrupted")
    })
  ).rejects.toThrow("interrupted")
  const journal = JSON.parse(await readFile(join(root, "browser-maintenance/pending.json"), "utf8"))
  await writeFile(
    join(root, "browser-maintenance", `.replace-${journal.stage}`, "next/Default/Preferences"),
    "corrupt-staging"
  )
  await expect(execute(root, input)).rejects.toThrow("大小不匹配")
  expect(await readFile(value, "utf8")).toBe("current-state")
})

it("rejects a database hard link before changing the browser or another database", async () => {
  const { root, value } = await fixture()
  const source = join(root, "unrelated.sqlite"),
    database = join(root, "bots.sqlite")
  await rename(database, source)
  await link(source, database)
  const original = await readFile(source)
  await expect(execute(root, { action: "reset", nonce: randomUUID() })).rejects.toThrow(
    "数据库不能是链接"
  )
  expect((await readFile(source)).equals(original)).toBe(true)
  expect(await readFile(value, "utf8")).toBe("browser-before")
})
