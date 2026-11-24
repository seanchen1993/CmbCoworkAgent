import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { openNativeSqliteDatabase } from "../../src/main/db/native-sqlite-adapter"
import { BotStore } from "../../src/main/bots/store"
import { LocalBotHost, type BotRunPort } from "../../src/main/bots/host"

async function main(): Promise<void> {
  // Real persistent host/storage; only model execution is deterministic in this fixture.
  const [mode, directory] = process.argv.slice(2)
  const database = openNativeSqliteDatabase(
    join(directory, "control.sqlite"),
    "Bot recovery test"
  ).database
  const store = new BotStore(database)
  const failures: string[] = []
  let started = 0
  const keepAlive = setInterval(() => {}, 1000)
  const send = (value: unknown) =>
    new Promise<void>((resolve, reject) => {
      process.send!(value, (error) => (error ? reject(error) : resolve()))
    })

  if (mode === "seed") {
    const create = (name: string) =>
      store.create({ name, instructions: "", color: "#ea2845", modelRef: null })
    const a = create("Approval"),
      b = create("External action"),
      c = create("Queued work")
    const sender = create("Sender"),
      peer = create("Peer")
    store.enqueue({ botId: a.id, requestId: "awaiting-approval", message: "Wait" })
    store.enqueue({ botId: b.id, requestId: "external-effect", message: "Write once" })
    store.enqueue({ botId: c.id, requestId: "pending-user", message: "Resume queued work" })
    const cancelled = store.enqueue({
      botId: c.id,
      requestId: "cancelled-user",
      message: "Do not run"
    })
    store.transition(cancelled.id, "cancelled")
    const root = store.enqueue({
      botId: sender.id,
      requestId: "delegate-root",
      message: "Delegate"
    })
    store.transition(root.id, "running")
    const delegated = store.delegate(root.id, peer.id, "Verify", "verify")
    store.transition(delegated.id, "running")
    store.settle(delegated.id, "completed", null, "Verified before crash")
    store.markRead("bot", peer.id, store.activities().find((item) => item.id === peer.id)!.version)
    store.settle(root.id, "completed", null, "Waiting for peer")
    const group = store.saveGroup({ name: "Review", memberIds: [c.id] })
    store.sendGroup({
      groupId: group.id,
      requestId: "group-request",
      text: "Review",
      targetBotIds: [c.id]
    })
    store.saveSchedule(
      c.id,
      {
        name: "Due routine",
        message: "Run once",
        frequency: "daily",
        runAtTime: "09:00",
        enabled: true
      },
      "2020-01-01T00:00:00.000Z"
    )
  }

  let host: LocalBotHost
  const runtime: BotRunPort = {
    onAvailable: () => () => {},
    acquire: (_bot, task) => ({
      release() {},
      async execute(signal, waiting) {
        if (task.origin.kind === "notification" && task.origin.notificationKind === "command") {
          if (!task.message.includes("outcome_unknown") ||
              !task.message.includes("do not repeat the command automatically"))
            failures.push("Recovered command receipt lost its uncertainty/non-replay boundary")
        }
        appendFileSync(
          join(directory, "effects.jsonl"),
          `${JSON.stringify({ requestId: task.requestId, mode })}\n`
        )
        if (mode === "seed") {
          if (task.requestId === "awaiting-approval") waiting(true)
          if (task.requestId === "external-effect") {
            const addition = store.enqueue({
              botId: task.botId, requestId: "consumed-addition", message: "Already consumed by this graph"
            })
            store.injectIntoRun(addition.id, task.id)
            host.commandLifecycle(task.id).accepted({
              id: "native-command-before-crash", threadId: task.threadId,
              command: "synthetic accepted process receipt", cwd: directory, startedAt: Date.now()
            })
          }
          if (++started === 2) await send({ kind: "ready", snapshot: host.snapshot() })
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          )
        }
        return { state: "completed", result: `Completed ${task.requestId}` }
      }
    })
  }
  host = new LocalBotHost(
    store,
    runtime,
    2,
    (error) => failures.push(String(error)),
    () => "2099-01-01T00:00:00.000Z"
  )
  if (mode === "resume") {
    const deadline = Date.now() + 10_000
    while (
      host
        .snapshot()
        .tasks.some((task) => ["running", "waiting_user", "queued"].includes(task.state)) ||
      host
        .snapshot()
        .schedules.some(
          (item) => item.enabled && item.nextRunAt && Date.parse(item.nextRunAt) <= Date.now()
        )
    ) {
      if (Date.now() > deadline) throw new Error("Host did not drain after recovery")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const snapshot = host.snapshot()
    const groupMessages = snapshot.groups.map((group) => store.groupMessages(group.id))
    await host.stop()
    database.close()
    clearInterval(keepAlive)
    await send({ kind: "recovered", snapshot, groupMessages, failures })
    process.disconnect!()
  }
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
