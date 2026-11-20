import assert from "node:assert/strict"
import { fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BotSnapshot, BotGroupMessage } from "../src/shared/bots/contracts"

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cmb-bots-recovery-"))
  const children = new Set<ChildProcess>()
  type Report = {
    kind: string
    snapshot: BotSnapshot
    groupMessages?: BotGroupMessage[][]
    failures?: string[]
  }
  function launch(mode: string): {
    child: ChildProcess
    report: Promise<Report>
    exited: Promise<unknown[]>
  } {
    const child = fork(
      new URL("./support/bots-recovery-process.ts", import.meta.url),
      [mode, directory],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"]
      }
    )
    children.add(child)
    let errors = ""
    child.stderr!.on("data", (chunk) => {
      errors = (errors + chunk).slice(-8000)
    })
    const exited = once(child, "exit")
    const report = new Promise<Report>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`Recovery fixture timed out: ${errors}`))
      }, 20_000)
      child.once("message", (message) => {
        clearTimeout(timer)
        resolve(message as Report)
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`Fixture exited before report: ${code}/${signal}: ${errors}`))
      })
    })
    return { child, report, exited }
  }
  try {
    const seed = launch("seed")
    const before = await seed.report
    assert.equal(before.kind, "ready")
    assert.equal(
      before.snapshot.tasks.find((task) => task.requestId === "awaiting-approval")?.state,
      "waiting_user"
    )
    assert.equal(
      before.snapshot.tasks.find((task) => task.requestId === "external-effect")?.state,
      "running"
    )
    seed.child.kill("SIGKILL")
    await seed.exited
    children.delete(seed.child)

    const resumed = launch("resume")
    const after = await resumed.report
    assert.equal(after.kind, "recovered")
    assert.deepEqual(after.failures, [])
    for (const requestId of ["awaiting-approval", "external-effect", "consumed-addition"])
      assert.equal(
        after.snapshot.tasks.find((task) => task.requestId === requestId)?.state,
        "interrupted"
      )
    const commandReceipts = after.snapshot.tasks.filter((task) =>
      task.origin.kind === "notification" && task.origin.notificationKind === "command"
    )
    assert.equal(commandReceipts.length, 1)
    assert.equal(commandReceipts[0].state, "completed")
    assert.equal(commandReceipts[0].message, "整理后台任务结果", "UI snapshot must not expose internal receipt data")
    assert.deepEqual(after.snapshot.backgroundThreads, [])
    assert.equal(
      after.snapshot.tasks.find((task) => task.requestId === "pending-user")?.state,
      "completed"
    )
    assert.equal(
      after.snapshot.tasks.find((task) => task.requestId === "cancelled-user")?.state,
      "cancelled"
    )
    assert.equal(after.snapshot.tasks.filter((task) => task.origin.kind === "schedule").length, 1)
    assert.equal(
      after.snapshot.tasks.filter((task) => task.requestId.startsWith("reply-")).length,
      1
    )
    assert.equal(after.groupMessages?.[0].length, 2)
    const peerId = after.snapshot.bots.find((bot) => bot.name === "Peer")!.id
    assert.equal(
      after.snapshot.activities.find((item) => item.kind === "bot" && item.id === peerId)?.unread,
      false
    )
    assert.equal(after.snapshot.activities.find((item) => item.kind === "group")?.unread, true)
    assert.equal(after.snapshot.bots.length, before.snapshot.bots.length)
    assert.deepEqual(
      after.snapshot.bots.map((bot) => bot.threadId),
      before.snapshot.bots.map((bot) => bot.threadId)
    )
    assert.deepEqual(await resumed.exited, [0, null])
    children.delete(resumed.child)

    // A second restart must not replay either completed work or the crash-interrupted action.
    const again = launch("resume")
    const repeated = await again.report
    assert.deepEqual(
      repeated.snapshot.activities,
      after.snapshot.activities,
      "Read cursors and previews survive restart without replaying unread activity"
    )
    assert.deepEqual(await again.exited, [0, null])
    children.delete(again.child)
    const effects = (await readFile(join(directory, "effects.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { requestId: string })
    const ids = effects.map((effect) => effect.requestId)
    assert.equal(new Set(ids).size, ids.length, "No task may execute twice across either restart")
    assert.equal(ids.includes("cancelled-user"), false)
    assert.equal(ids.includes("consumed-addition"), false, "Consumed additions must not become separate runs after crash")
    console.log(
      "PASS: real Host SIGKILL/restart preserves identities, queue, group results and routine/reply deduplication; interrupted effects are not replayed. Model execution is a deterministic fixture."
    )
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill("SIGKILL")
        await exited
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
