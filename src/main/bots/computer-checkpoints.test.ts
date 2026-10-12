import { afterEach, expect, it, vi } from "vitest"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotSharedWorkspace } from "./shared-workspace"
import {
  executeBotComputerCheckpoint,
  listBotComputerCheckpoints,
  listBotComputerRecoveryCopies,
  deleteBotComputerRecoveryCopy,
  listBotComputerDeliverables,
  resolveBotComputerDeliverables
} from "./computer-checkpoint-service"
import { BotWorkflowStore } from "./workflow-store"
import { createWorkflowWorktree, persistWorkflowWorktreeRecord } from "../services/git-worktree"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { WorkflowWorktreeRecord } from "../agent/workflow/types"
import { computerManifest } from "./computer-checkpoint-manifest"
import { BotMaintenanceReceipts } from "./maintenance-receipts"
import { cleanupComputerDeliveryRecords } from "./computer-checkpoint-managed"
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
    await rm(`${root}.workspace`, { recursive: true, force: true })
  }
})
const options = {
  nativeEntry: resolve("src/main/bots/computer-checkpoint-native-entry.ts"),
  nativeExecArgv: ["--import", "tsx"]
}
async function singleDeliveryReader<T>(read: () => Promise<T>): Promise<T> {
  const open = BotMaintenanceReceipts.readOnly
  let closed = 0
  const spy = vi.spyOn(BotMaintenanceReceipts, "readOnly").mockImplementation((directory) => {
    const ledger = open(directory)
    if (ledger) {
      const close = ledger.close.bind(ledger)
      vi.spyOn(ledger, "close").mockImplementation(() => {
        closed++
        close()
      })
    }
    return ledger
  })
  try {
    return await read()
  } finally {
    const calls = spy.mock.calls.length
    spy.mockRestore()
    expect(calls).toBe(1)
    expect(closed).toBe(1)
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-computer-")))
  roots.push(root)
  const workspace = await BotSharedWorkspace.open(root),
    store = new BotStore(join(root, "bots.sqlite"), undefined, undefined, workspace.path)
  const bot = store.createBot({ nonce: "bot", name: "Captured name" })
  store.send({
    nonce: "unfinished",
    conversationId: bot.conversationId,
    text: "Never automatically replay"
  })
  store.close()
  await writeFile(join(workspace.path, "note.txt"), "captured work")
  await mkdir(join(root, "browser-profile"))
  await writeFile(join(root, "browser-profile", "Local State"), "captured profile")
  return { root, workspace, bot }
}
it("uses the actual SQLite thread to capture and atomically restore data, shared files and browser with fresh task fences", async () => {
  const f = await fixture(),
    nonce = randomUUID()
  const created = await executeBotComputerCheckpoint(f.root, { action: "create", nonce }, options)
  if (created.action !== "create") throw new Error("Expected creation")
  expect(created.checkpoint).toMatchObject({
    id: nonce,
    data: "established",
    shared: "established",
    browser: "established"
  })
  const store = new BotStore(join(f.root, "bots.sqlite"), undefined, undefined, f.workspace.path)
  const old = store.getBot(f.bot.bot.id)
  store.updateBot({ id: old.id, revision: old.revision, name: "Later name" })
  store.close()
  await writeFile(join(f.workspace.path, "note.txt"), "later work")
  await writeFile(join(f.root, "browser-profile", "Local State"), "later profile")
  const restoreNonce = randomUUID(),
    request = {
      action: "restore",
      nonce: restoreNonce,
      checkpoint: { id: nonce, sha256: created.checkpoint.sha256 }
    } as const
  expect(await executeBotComputerCheckpoint(f.root, request, options)).toMatchObject({
    action: "restore",
    restartRequired: true,
    reviewRequired: true
  })
  expect(await readFile(join(f.workspace.path, "note.txt"), "utf8")).toBe("captured work")
  expect(await readFile(join(f.root, "browser-profile", "Local State"), "utf8")).toBe(
    "captured profile"
  )
  const current = new BotStore(join(f.root, "bots.sqlite"), undefined, undefined, f.workspace.path)
  expect(current.getBot(old.id).name).toBe("Captured name")
  expect(
    current.db.exec("SELECT status FROM bot_runs")[0].values.every((row) => row[0] === "cancelled")
  ).toBe(true)
  current.close()
  // The original ACK can be lost. This exact request returns its durable receipt
  // instead of replaying the restoration over subsequent legitimate file edits.
  await writeFile(join(f.workspace.path, "note.txt"), "edited after restore")
  expect(await executeBotComputerCheckpoint(f.root, request, options)).toMatchObject({
    recoveryCopy: restoreNonce
  })
  expect(await readFile(join(f.workspace.path, "note.txt"), "utf8")).toBe("edited after restore")
  const copies = await listBotComputerRecoveryCopies(f.root)
  expect(copies).toHaveLength(1)
  await deleteBotComputerRecoveryCopy(
    f.root,
    { id: copies[0].id, sha256: copies[0].sha256 },
    options
  )
  await deleteBotComputerRecoveryCopy(
    f.root,
    { id: copies[0].id, sha256: copies[0].sha256 },
    options
  )
  expect(await listBotComputerRecoveryCopies(f.root)).toEqual([])
}, 20_000)
it("keeps deleted create identities retired across retries and lists only published points", async () => {
  const f = await fixture(),
    nonce = randomUUID(),
    input = { action: "create", nonce } as const
  const created = await executeBotComputerCheckpoint(f.root, input, options)
  if (created.action !== "create") throw new Error("Expected creation")
  expect(await executeBotComputerCheckpoint(f.root, input, options)).toEqual(created)
  expect(await listBotComputerCheckpoints(f.root)).toHaveLength(1)
  const request = {
    action: "delete",
    checkpoint: { id: nonce, sha256: created.checkpoint.sha256 }
  } as const
  await executeBotComputerCheckpoint(f.root, request, options)
  await executeBotComputerCheckpoint(f.root, request, options)
  expect(await listBotComputerCheckpoints(f.root)).toEqual([])
  await expect(executeBotComputerCheckpoint(f.root, input, options)).rejects.toMatchObject({
    code: "snapshot_deleted"
  })
}, 20_000)
it("captures absent components without initializing a workspace or browser", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cmb-computer-absent-")))
  roots.push(root)
  const created = await executeBotComputerCheckpoint(
    root,
    { action: "create", nonce: randomUUID() },
    options
  )
  if (created.action !== "create") throw new Error("Expected creation")
  expect(created.checkpoint).toMatchObject({
    data: "absent",
    shared: "absent",
    browser: "absent",
    bytes: 0,
    files: 0
  })
  await expect(readFile(join(root, "workspace.private.json"))).rejects.toMatchObject({
    code: "ENOENT"
  })
}, 20_000)

import { spawn } from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { BotHostLock } from "./host-lock"
import { recoverBotComputerCheckpoint } from "./computer-checkpoint-service"
async function crashAt(root: string, request: unknown, step: string) {
  const modulePath = pathToFileURL(resolve("src/main/bots/computer-checkpoint-service.ts")).href
  const code = `const imported = await import(${JSON.stringify(modulePath)}); const service = imported.default ?? imported;
  const request = ${JSON.stringify(request)};
  try { await (request.action === "delete-recovery" ? service.deleteBotComputerRecoveryCopy(${JSON.stringify(root)}, request.recovery, {
    nativeEntry:${JSON.stringify(options.nativeEntry)},nativeExecArgv:["--import","tsx"],
    afterStep: async step => { if (step === ${JSON.stringify(step)}) { process.send({step}); await new Promise(() => {}); } }
  }) : service.executeBotComputerCheckpoint(${JSON.stringify(root)}, request, {
    nativeEntry:${JSON.stringify(options.nativeEntry)},nativeExecArgv:["--import","tsx"],
    afterStep: async step => { if (step === ${JSON.stringify(step)}) { process.send({step}); await new Promise(() => {}); } }
  })); process.exit(0); } catch(error) { process.stderr.write(String(error.stack)); process.exit(1); }`
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true
  })
  const output: Buffer[] = []
  child.stderr!.on("data", (bytes) => output.push(bytes))
  const exited = once(child, "exit")
  void exited.catch(() => {})
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Checkpoint stage not reached: " + Buffer.concat(output).toString()))
    }, 15_000)
    child.once("message", (message: unknown) => {
      if (message && typeof message === "object" && "step" in message && message.step === step) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Checkpoint worker exited ${code}: ${Buffer.concat(output).toString()}`))
    })
  })
  child.kill("SIGKILL")
  await exited
}
it.each([
  "journal.published",
  "slot.old:database",
  "slot.next:database",
  "slot.next:shared",
  "restore.completed"
])(
  "resumes one real killed coordinator at %s before any Store or runtime is opened",
  async (step) => {
    const f = await fixture(),
      created = await executeBotComputerCheckpoint(
        f.root,
        { action: "create", nonce: randomUUID() },
        options
      )
    if (created.action !== "create") throw new Error("Expected creation")
    await writeFile(join(f.workspace.path, "note.txt"), "displaced original")
    await writeFile(join(f.root, "browser-profile", "Local State"), "displaced browser")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
    } as const
    await crashAt(f.root, request, step)
    const lock = BotHostLock.acquire(f.root)
    if (!lock) throw new Error("Killed process left a live lock owner")
    try {
      await recoverBotComputerCheckpoint(f.root, lock, options)
    } finally {
      lock.release()
    }
    expect(await readFile(join(f.workspace.path, "note.txt"), "utf8")).toBe("captured work")
    expect(await readFile(join(f.root, "browser-profile", "Local State"), "utf8")).toBe(
      "captured profile"
    )
    await expect(readFile(join(f.root, "computer-recovery", "pending.json"))).rejects.toMatchObject(
      { code: "ENOENT" }
    )
    expect(await executeBotComputerCheckpoint(f.root, request, options)).toMatchObject({
      recoveryCopy: request.nonce
    })
  },
  30_000
)
it("rejects a modified already-moved data tree and preserves the displaced original after process death", async () => {
  const f = await fixture(),
    created = await executeBotComputerCheckpoint(
      f.root,
      { action: "create", nonce: randomUUID() },
      options
    )
  if (created.action !== "create") throw new Error("Expected creation")
  const request = {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
  } as const
  await crashAt(f.root, request, "slot.next:database")
  const journal = JSON.parse(
    await readFile(join(f.root, "computer-recovery", "pending.json"), "utf8")
  ) as { stage: string }
  const before = await readFile(
    join(f.root, "computer-recovery", `.restore-${journal.stage}`, "old", "bots.sqlite")
  )
  await writeFile(join(f.root, "bots.sqlite"), "tampered current database")
  const lock = BotHostLock.acquire(f.root)!
  try {
    await expect(recoverBotComputerCheckpoint(f.root, lock, options)).rejects.toThrow()
  } finally {
    lock.release()
  }
  expect(
    await readFile(
      join(f.root, "computer-recovery", `.restore-${journal.stage}`, "old", "bots.sqlite")
    )
  ).toEqual(before)
  expect(await readFile(join(f.root, "computer-recovery", "pending.json"), "utf8")).toContain(
    request.nonce
  )
}, 30_000)
it("recovers a create whose publication succeeded before the ACK or receipt update arrived", async () => {
  const f = await fixture(),
    request = { action: "create", nonce: randomUUID() } as const
  await crashAt(f.root, request, "point.published")
  const first = await executeBotComputerCheckpoint(f.root, request, options)
  expect(await executeBotComputerCheckpoint(f.root, request, options)).toEqual(first)
  expect(await listBotComputerCheckpoints(f.root)).toHaveLength(1)
}, 30_000)
it.each([false, true])(
  "removes a proven unpublished preparation after SIGKILL and supports exact or new restore nonce=%s",
  async (freshNonce) => {
    const f = await fixture(),
      created = await executeBotComputerCheckpoint(
        f.root,
        { action: "create", nonce: randomUUID() },
        options
      )
    if (created.action !== "create") throw new Error("Expected creation")
    await writeFile(join(f.workspace.path, "note.txt"), "still original before publication")
    const request = {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
    } as const
    await crashAt(f.root, request, "prepare.started")
    expect(await readFile(join(f.workspace.path, "note.txt"), "utf8")).toBe(
      "still original before publication"
    )
    const retry = freshNonce ? { ...request, nonce: randomUUID() } : request
    await executeBotComputerCheckpoint(f.root, retry, options)
    await expect(
      readFile(join(f.root, "computer-recovery", `preparing-${request.nonce}.json`))
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      readFile(join(f.root, "computer-recovery", `.restore-${request.nonce}`, "prepared.json"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await listBotComputerRecoveryCopies(f.root)).toHaveLength(1)
  },
  30_000
)
it("keeps partially deleted recovery sets discoverable and resumes from the independent durable inode proof", async () => {
  const f = await fixture(),
    created = await executeBotComputerCheckpoint(
      f.root,
      { action: "create", nonce: randomUUID() },
      options
    )
  if (created.action !== "create") throw new Error("Expected creation")
  const restored = await executeBotComputerCheckpoint(
    f.root,
    {
      action: "restore",
      nonce: randomUUID(),
      checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
    },
    options
  )
  if (restored.action !== "restore") throw new Error("Expected restoration")
  const copies = await listBotComputerRecoveryCopies(f.root),
    selection = { id: copies[0].id, sha256: copies[0].sha256 }
  await crashAt(
    f.root,
    { action: "delete-recovery", recovery: selection },
    "recovery.shared-deleted"
  )
  await rm(join(f.root, "computer-recovery", "recovery", selection.id, "journal.json"))
  expect(await listBotComputerRecoveryCopies(f.root)).toEqual(copies)
  await deleteBotComputerRecoveryCopy(f.root, selection, options)
  await deleteBotComputerRecoveryCopy(f.root, selection, options)
  expect(await listBotComputerRecoveryCopies(f.root)).toEqual([])
}, 30_000)
it("retries a point deletion whose manifest was already removed after durable retirement", async () => {
  const f = await fixture(),
    created = await executeBotComputerCheckpoint(
      f.root,
      { action: "create", nonce: randomUUID() },
      options
    )
  if (created.action !== "create") throw new Error("Expected creation")
  const request = {
    action: "delete",
    checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
  } as const
  await crashAt(f.root, request, "point.deletion-sealed")
  await rm(join(f.root, "computer-recovery", "points", request.checkpoint.id, "manifest.json"))
  await executeBotComputerCheckpoint(f.root, request, options)
  await executeBotComputerCheckpoint(f.root, request, options)
  expect(await listBotComputerCheckpoints(f.root)).toEqual([])
}, 30_000)
it("keeps independently restored Git results listed and authorized after raw and original checkpoint cleanup", async () => {
  const f = await fixture(),
    project = join(f.root, "project"),
    appDataRoot = `${f.root}-workspaces`
  roots.push(appDataRoot)
  await mkdir(project)
  const git = async (cwd: string, ...args: string[]) =>
    (
      await promisify(execFile)("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-C",
        cwd,
        ...args
      ])
    ).stdout.trimEnd()
  await git(project, "init", "-b", "main")
  await writeFile(join(project, "app.txt"), "base\n")
  await git(project, "add", "app.txt")
  await git(project, "commit", "-m", "base")
  const store = new BotStore(join(f.root, "bots.sqlite"), undefined, undefined, f.workspace.path),
    parent = store.claim("fixture", 300_000)!,
    workflow = BotWorkflowStore.open(store, parent.lease, "call", {
      script: 'export const meta={name:"Test",description:"Test"}; return "ok"',
      maxConcurrency: 1,
      defaultModelId: "test",
      agentProfiles: [],
      authority: {}
    }),
    child = store.workflowChildren.claim(workflow, parent.lease, {
      prompt: "Work",
      label: "Work",
      phase: null,
      agentIndex: 1,
      isolation: "worktree",
      toolStreamKey: `${"a".repeat(64)}_c1`,
      durableCallKey: `${"a".repeat(64)}_n1`
    }),
    info = await createWorkflowWorktree({
      workspacePath: project,
      appDataRoot,
      runId: parent.run.id,
      threadId: child.run.id,
      persistOwnership: true
    }),
    record: WorkflowWorktreeRecord = {
      ...info,
      id: info.name,
      runId: parent.run.id,
      threadId: child.run.id,
      status: "ready",
      dirty: true,
      updatedAt: new Date().toISOString()
    }
  delete (record as WorkflowWorktreeRecord & { name?: string }).name
  await persistWorkflowWorktreeRecord(record, appDataRoot)
  store.db.run("INSERT INTO bot_worktrees VALUES(?,?,?,?)", [
    child.run.id,
    workflow.id,
    JSON.stringify(record),
    Date.now()
  ])
  store.close()
  await writeFile(join(record.directory, "app.txt"), "staged\n")
  await git(record.directory, "add", "app.txt")
  await writeFile(join(record.directory, "app.txt"), "saved latest work\n")
  const created = await executeBotComputerCheckpoint(
    f.root,
    { action: "create", nonce: randomUUID() },
    options
  )
  if (created.action !== "create") throw new Error("Expected creation")
  expect(created.checkpoint.managedGit).toEqual({ complete: 1, filesOnly: 0 })
  const pointRoot = join(f.root, "computer-recovery", "points", created.checkpoint.id),
    manifest = JSON.parse(await readFile(join(pointRoot, "manifest.json"), "utf8")),
    summary = await readFile(join(pointRoot, "summary.json"))
  expect(
    computerManifest.safeParse({ ...manifest, managedGit: { complete: 0, filesOnly: 1 } }).success
  ).toBe(false)
  await writeFile(join(pointRoot, "summary.json"), JSON.stringify({ complete: 1, filesOnly: 1 }))
  await expect(listBotComputerCheckpoints(f.root)).rejects.toThrow()
  await writeFile(join(pointRoot, "summary.json"), summary)
  const request = {
    action: "restore",
    nonce: randomUUID(),
    checkpoint: { id: created.checkpoint.id, sha256: created.checkpoint.sha256 }
  } as const
  await executeBotComputerCheckpoint(f.root, request, options)
  const secondRequest = { ...request, nonce: randomUUID() }
  await executeBotComputerCheckpoint(f.root, secondRequest, options)
  const copies = await listBotComputerRecoveryCopies(f.root)
  await deleteBotComputerRecoveryCopy(
    f.root,
    { id: copies[0].id, sha256: copies[0].sha256 },
    options
  )
  await executeBotComputerCheckpoint(
    f.root,
    { action: "delete", checkpoint: request.checkpoint },
    options
  )
  expect(await singleDeliveryReader(() => listBotComputerDeliverables(f.root))).toEqual(
    expect.arrayContaining([
      { id: request.nonce, checkpoint: request.checkpoint, projects: 1 },
      { id: secondRequest.nonce, checkpoint: request.checkpoint, projects: 1 }
    ])
  )
  const lock = BotHostLock.acquire(f.root)!
  try {
    const owner = {
      assertCurrent: () => lock.assertCurrent(),
      checkCurrent: () => lock.checkCurrent(),
      identity: () => lock.recoveryOwnershipIdentity()
    }
    await singleDeliveryReader(() => cleanupComputerDeliveryRecords(f.root, owner))
    const corruptRecord = join(
      f.root,
      "computer-recovery",
      "deliverable-records",
      `${randomUUID()}.json`
    )
    await writeFile(corruptRecord, "{}")
    await singleDeliveryReader(() =>
      expect(cleanupComputerDeliveryRecords(f.root, owner)).rejects.toThrow()
    )
    await rm(corruptRecord)
  } finally {
    lock.release()
  }
  const path = await resolveBotComputerDeliverables(f.root, request.nonce),
    names = await (await import("node:fs/promises")).readdir(path),
    output = join(path, names[0])
  expect(await readFile(join(output, "app.txt"), "utf8")).toBe("saved latest work\n")
  await writeFile(join(output, "app.txt"), "reviewer legitimate edit")
  expect(await resolveBotComputerDeliverables(f.root, request.nonce)).toBe(path)
  await rename(path, path + ".moved")
  await mkdir(path)
  await expect(resolveBotComputerDeliverables(f.root, request.nonce)).rejects.toThrow("校验失败")
  await rmdir(path)
  await rename(path + ".moved", path)
  const foreign = randomUUID()
  await mkdir(join(f.root, "computer-recovery", "deliverables", foreign))
  await singleDeliveryReader(() => expect(listBotComputerDeliverables(f.root)).rejects.toThrow())
  await singleDeliveryReader(() =>
    expect(resolveBotComputerDeliverables(f.root, foreign)).rejects.toThrow()
  )
  await rmdir(join(f.root, "computer-recovery", "deliverables", foreign))
  await rename(path, join(f.root, "exported-code"))
  await rename(
    await resolveBotComputerDeliverables(f.root, secondRequest.nonce),
    join(f.root, "exported-second-code")
  )
  await executeBotComputerCheckpoint(f.root, { action: "create", nonce: randomUUID() }, options)
  expect(await listBotComputerDeliverables(f.root)).toEqual([])
  await expect(
    readFile(join(f.root, "computer-recovery", "deliverable-records", `${request.nonce}.json`))
  ).rejects.toMatchObject({ code: "ENOENT" })
  expect(await executeBotComputerCheckpoint(f.root, request, options)).toMatchObject({
    recoveryCopy: request.nonce
  })
  expect(await readFile(join(f.root, "exported-code", names[0], "app.txt"), "utf8")).toBe(
    "reviewer legitimate edit"
  )
}, 40_000)
