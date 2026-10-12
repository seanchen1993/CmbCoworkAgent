import { spawn } from "node:child_process"
import { once } from "node:events"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { botComputerCheckpointResult } from "../../shared/bot-computer-checkpoint"
import { BotStore } from "./store"
import { BotSharedWorkspace } from "./shared-workspace"

const enabled = process.env.CMB_BOT_COMPUTER_PROCESS_TEST === "1",
  roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true })
    await rm(`${root}.workspace`, { force: true, recursive: true })
  }
})
async function compiled(directory: string, request: unknown) {
  const executable =
      process.env.CMB_BOT_NODE ?? (createRequire(import.meta.url)("electron") as string),
    child = spawn(
      executable,
      [resolve("out/main/bot-computer-checkpoint.js"), "--data-dir", directory],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    ),
    output: Buffer[] = [],
    errors: Buffer[] = []
  child.stdout.on("data", (bytes) => output.push(bytes))
  child.stderr.on("data", (bytes) => errors.push(bytes))
  const completed = once(child, "close"),
    deadline = setTimeout(() => child.kill("SIGKILL"), 30_000)
  try {
    child.stdin.end(JSON.stringify(request))
    const [code] = await completed
    const frames = Buffer.concat(output)
      .toString()
      .trimEnd()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { type: string; ok?: boolean; result?: unknown; error?: unknown }
      )
    const last = frames.at(-1)
    expect(code, Buffer.concat(errors).toString()).toBe(0)
    expect(last, JSON.stringify(last)).toMatchObject({ type: "result", ok: true })
    return botComputerCheckpointResult.parse(last?.result)
  } finally {
    clearTimeout(deadline)
    child.kill("SIGKILL")
  }
}
it.skipIf(!enabled)(
  "runs the shipped computer coordinator and SQLite thread with data/files/browser recovery and durable lost-ACK retry",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-compiled-computer-")))
    roots.push(root)
    const workspace = await BotSharedWorkspace.open(root),
      store = new BotStore(join(root, "bots.sqlite"), undefined, undefined, workspace.path),
      bot = store.createBot({ nonce: "compiled-bot", name: "Saved compiled bot" })
    store.send({
      nonce: "pending",
      conversationId: bot.conversationId,
      text: "Do not replay an old task"
    })
    store.close()
    await writeFile(join(workspace.path, "note.txt"), "saved work")
    await mkdir(join(root, "browser-profile"))
    await writeFile(join(root, "browser-profile", "Local State"), "saved profile")
    const createRequest = { action: "create", nonce: randomUUID() },
      created = await compiled(root, createRequest)
    if (created.action !== "create") throw new Error("Expected creation")
    expect(created.checkpoint).toMatchObject({
      data: "established",
      shared: "established",
      browser: "established"
    })
    expect(await compiled(root, createRequest)).toEqual(created)
    await writeFile(join(workspace.path, "note.txt"), "displaced work")
    await writeFile(join(root, "browser-profile", "Local State"), "displaced profile")
    const request = {
        action: "restore",
        nonce: randomUUID(),
        checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
      },
      restored = await compiled(root, request)
    expect(restored).toMatchObject({ action: "restore", restartRequired: true })
    expect(await readFile(join(workspace.path, "note.txt"), "utf8")).toBe("saved work")
    expect(await readFile(join(root, "browser-profile", "Local State"), "utf8")).toBe(
      "saved profile"
    )
    const reopened = new BotStore(join(root, "bots.sqlite"), undefined, undefined, workspace.path)
    try {
      expect(reopened.getBot(bot.bot.id).name).toBe("Saved compiled bot")
      expect(
        reopened.db
          .exec("SELECT status FROM bot_runs")[0]
          .values.every((row) => row[0] === "cancelled")
      ).toBe(true)
    } finally {
      reopened.close()
    }
    // Discard the first ACK. Its exact request returns its receipt without
    // overwriting edits legitimately made after the restore completed.
    await writeFile(join(workspace.path, "note.txt"), "edited after completion")
    expect(await compiled(root, request)).toEqual(restored)
    expect(await readFile(join(workspace.path, "note.txt"), "utf8")).toBe("edited after completion")
  },
  90_000
)
