import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app, type UtilityProcess } from "electron"
import { FunctionModsManager } from "../../src/main/mods/v2/manager"
import { FunctionRuntimeClient } from "../../src/main/mods/v2/runtime-client"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"
import { ModControlStore } from "../../src/main/mods/control-store"
import { openNativeSqliteDatabase } from "../../src/main/db/native-sqlite-adapter"
import { FunctionConversationStore } from "../../src/main/db/function-conversation-store"
import { FunctionConversationRegistry } from "../../src/main/mods/v2/conversation-registry"
import { FunctionSessionAppendTicket } from "../../src/main/mods/v2/session-append-ticket"
import { ModRuntimeAuthorities } from "../../src/main/mods/runtime-instance"
import { captureThreadIncarnation } from "../../src/main/services/thread-incarnation"

const output = resolve(process.argv[2]),
  hostEntry = resolve(process.argv[3])
mkdirSync(join(output, "electron-profile"), { recursive: true })
mkdirSync(join(output, "electron-session"), { recursive: true })
app.setPath("userData", join(output, "electron-profile"))
app.setPath("sessionData", join(output, "electron-session"))
app.commandLine.appendSwitch("disable-gpu")

interface ChildFact {
  id: number
  scenario: string
  createdAt: number
  pid?: number
  loadedAt?: number
  quiescent?: boolean
  exitedAt?: number
  exitCode?: number
  drainRequestedAt?: number
  drainedAt?: number
}
const facts: ChildFact[] = [],
  live = new Set<ChildFact>(),
  checks: string[] = []
const closeFixtures: Array<() => Promise<void>> = []
let peakLiveChildren = 0
const signal = new AbortController().signal
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function record(check: string): void {
  checks.push(check)
  console.log("PASS " + check)
}
async function waitFor(check: () => boolean, reason: string): Promise<void> {
  const end = performance.now() + 10_000
  while (!check()) {
    assert(performance.now() < end, reason)
    await pause(20)
  }
}

async function fixture(scenario: string) {
  const base = join(output, scenario),
    workspace = join(base, "workspace")
  const plugin = join(base, "plugin"),
    name = "native-reclaim-probe"
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(plugin, "hooks"), { recursive: true })
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  writeFileSync(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  writeFileSync(
    join(plugin, "hooks/register.ts"),
    `export function register(on) {
    let count = 0, appended = 0;
    on("session.start",async($,e,next)=>{
      const id=await $.session.id();
      await $.store.set("starts:"+id,(await $.store.get("starts:"+id)??0)+1);
      await $.command.register({name:"probe",description:"Native closure probe"});return next(e)
    });
    on("command.run",{command:"probe"},()=>({text:String(++count)}));
    on("session.append",($,e,next)=>next({...e,message:{...e.message,
      content:[...e.message.content,{type:"text",text:"append:"+(++appended)}]}}));
  }`
  )
  const control = new ModControlStore(join(base, "control.sqlite"))
  const database = openNativeSqliteDatabase(join(base, "conversations.sqlite")).database
  database.run("CREATE TABLE threads(thread_id TEXT PRIMARY KEY,created_at INTEGER,metadata TEXT)")
  database.run("CREATE TABLE canonical(uuid TEXT PRIMARY KEY,payload TEXT NOT NULL)")
  const conversations = new FunctionConversationStore(database)
  const authorities = new ModRuntimeAuthorities()
  const registry = new FunctionConversationRegistry(conversations, authorities)
  const clients: FunctionRuntimeClient[] = []
  const thread = (threadId: string) =>
    database.prepareReadOne("SELECT created_at,metadata FROM threads WHERE thread_id=?")([threadId])
  const assertThread = (key: string, id: string) => {
    assert.equal(key, workspace)
    const row = thread(id)
    assert(row && JSON.parse(String(row.metadata)).workspacePath === workspace)
  }
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => [{ id: "source", name, path: plugin, enabled: true }],
      enabled: () => true,
      assertThread,
      capabilityContext: (_workspace, id) => ({
        usage: "chat",
        identity: String(thread(id)?.metadata)
      }),
      publish: async (_workspace, value, active) => {
        active.throwIfAborted()
        return value
      },
      readSession: async () => ({}),
      changed: () => {}
    },
    () => {
      const client = new FunctionRuntimeClient(hostEntry)
      clients.push(client)
      const fact: ChildFact = { id: facts.length, scenario, createdAt: performance.now() }
      facts.push(fact)
      return {
        get stats() {
          return client.stats
        },
        async load(code, options) {
          const pending = client.load(code, options)
          void pending.catch(() => {})
          // request() forks synchronously before its first ready await: count opening physical
          // children too, rather than waiting for a successful load to report occupancy.
          const child = client.captureUiResolvePhysicalLifetime().owner as UtilityProcess
          child.once("spawn", () => {
            fact.pid = child.pid
          })
          child.once("exit", (code) => {
            fact.exitedAt = performance.now()
            fact.exitCode = code
            live.delete(fact)
          })
          live.add(fact)
          peakLiveChildren = Math.max(peakLiveChildren, live.size)
          assert(
            live.size <= 6,
            "Opening a seventh physical utility before retirement is forbidden"
          )
          const guest = await pending
          assert(client.stats.pid, "A real utility process PID is required")
          fact.pid = client.stats.pid
          fact.loadedAt = performance.now()
          fact.quiescent = guest.registrationQuiescent
          return guest
        },
        stop: () => client.stop(),
        async stopAndDrain() {
          fact.drainRequestedAt ??= performance.now()
          await client.stopAndDrain()
          if (fact.pid)
            assert(fact.exitedAt !== undefined, "Drain ACK must follow actual child exit")
          fact.drainedAt ??= performance.now()
        }
      }
    }
  )
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    manager.close()
    await Promise.all(clients.map((client) => client.stopAndDrain()))
    await waitFor(
      () => manager.runtimeSessions().retiring === 0,
      "Manager retirement did not settle"
    )
    await waitFor(
      () => !facts.some((fact) => fact.scenario === scenario && fact.pid && !fact.exitedAt),
      "An owned native child survived cleanup"
    )
    registry.close()
    authorities.close()
    control.close()
    database.close()
  }
  closeFixtures.push(close)
  const compiled = await compileFunctionPlugin(plugin)
  control.grant(workspace, `function:${name}`, compiled.digest, true)
  const ensure = (id: string) => {
    if (!thread(id))
      database.run("INSERT INTO threads VALUES(?,?,?)", [
        id,
        Date.now(),
        JSON.stringify({ workspacePath: workspace, cmb_thread_incarnation: randomUUID() })
      ])
  }
  const row = (id: string) => manager.runtimeSessions().sessions.find((row) => row.threadId === id)
  const discover = async (id: string) => {
    ensure(id)
    assert.equal(await manager.hasEventHandler(workspace, id, "command.run"), true)
    assert(manager.runtimeSessions().resident <= 6)
  }
  const starts = (id: string) =>
    control.functionState.get(JSON.stringify([workspace, name]), "starts:" + id)
  const run = async (id: string) => {
    ensure(id)
    const [command] = await manager.commands(workspace, id)
    assert(command)
    return manager.runCommand(workspace, id, command, "", signal)
  }
  const append = async (id: string) => {
    ensure(id)
    const physical = thread(id)!
    const ref = conversations.ensureMain(
      {
        threadId: id,
        workspace,
        checkpointNamespace: "",
        incarnation: captureThreadIncarnation({
          created_at: Number(physical.created_at),
          metadata: String(physical.metadata)
        })
      },
      () => assertThread(workspace, id)
    )
    const target = registry.registerMain(
      {},
      {
        identity: {},
        ref,
        checkpointThreadId: id,
        signal,
        assertCurrent: () => conversations.assertCurrent(ref)
      }
    )
    const ticket: FunctionSessionAppendTicket = new FunctionSessionAppendTicket({
      kind: "native",
      target,
      signal,
      input: {
        uuid: randomUUID(),
        door: "prompt",
        origin: { kind: "composer" },
        message: { type: "user", role: "user", content: [{ type: "text", text: "native input" }] }
      },
      assertCurrent: () => {
        assertThread(workspace, id)
        target.assertCurrent()
      },
      protect: async (input) => input,
      prepare: async (safe) => ({
        commit: (guard) =>
          conversations.commit(
            ref,
            {
              uuid: safe.uuid,
              inputDigest: ticket.inputDigest,
              door: safe.door,
              origin: safe.origin,
              message: safe.message,
              nativePayload: JSON.stringify(safe.message),
              orderAnchor: { fixture: "native-composer" },
              inbox: false,
              sdk: false
            },
            guard,
            (db, _ref, saved) =>
              db.run("INSERT INTO canonical VALUES(?,?)", [saved.uuid, saved.nativePayload]),
            (db, _ref, saved) =>
              assert.equal(
                db.prepareReadOne("SELECT payload FROM canonical WHERE uuid=?")([saved.uuid])
                  ?.payload,
                saved.nativePayload
              )
          ),
        read: () => conversations.readReceipt(ref, safe.uuid)
      })
    })
    const result = await manager.appendConversation(workspace, id, ticket)
    assert(ticket.committedRow, "The real native ticket must have committed a canonical SQLite row")
    return result
  }
  return { manager, workspace, row, discover, starts, run, append, clients, close }
}

async function acceptance(): Promise<void> {
  const pure = await fixture("pure-registration")
  for (let index = 0; index < 6; index++) await pure.discover(`quiet-${index}`)
  assert.equal(live.size, 6)
  assert(
    pure.manager.runtimeSessions().sessions.every((row) => row.autoReclaimable && !row.guestEntered)
  )
  const old = facts.find((fact) => fact.scenario === "pure-registration")!
  assert(
    facts.every((fact) => fact.quiescent === true),
    "Final host must supply native VM proof"
  )
  await pure.discover("seven")
  assert.equal(pure.manager.runtimeSessions().resident, 6)
  assert.equal(pure.row("quiet-0"), undefined)
  assert(old.exitedAt !== undefined && old.drainedAt !== undefined)
  const replacement = facts.at(-1)!
  assert(old.exitedAt <= old.drainedAt && old.drainedAt <= replacement.createdAt)
  assert.equal(live.size, 6)
  await waitFor(
    () => !app.getAppMetrics().some((metric) => metric.pid === old.pid),
    "The retired native child remained in Electron process metrics"
  )
  for (const id of ["seven", ...Array.from({ length: 6 }, (_, i) => `quiet-${i}`)])
    assert.equal(pure.starts(id), undefined)
  record("six real quiet VMs admit seven only after actual old child exit, with no startup effects")
  await Promise.all([pure.discover("eight"), pure.discover("eight"), pure.discover("nine")])
  assert.equal(
    pure.clients.length,
    9,
    "Concurrent same scope must not allocate two native children"
  )
  assert.equal(live.size, 6)
  record("same-scope coalescing and concurrent pressure retain at most six real utility children")
  await pure.close()
  assert.equal(live.size, 0)

  const used = await fixture("used-closures")
  await used.discover("started")
  assert.deepEqual(await used.run("started"), { text: "1" })
  await used.discover("appended")
  const first = await used.append("appended")
  assert(JSON.stringify(first).includes("append:1"))
  assert.equal(used.starts("appended"), undefined)
  const generations = [used.row("started")!.generation, used.row("appended")!.generation]
  assert.equal(used.row("appended")!.guestEntered, true)
  assert.equal(used.row("appended")!.autoReclaimable, false)
  for (let index = 0; index < 10; index++) await used.discover(`pressure-${index}`)
  assert.deepEqual([used.row("started")!.generation, used.row("appended")!.generation], generations)
  assert.deepEqual(await used.run("started"), { text: "2" })
  assert.equal(used.starts("started"), 1)
  assert(JSON.stringify(await used.append("appended")).includes("append:2"))
  assert.equal(used.starts("appended"), undefined)
  record(
    "actual command and native SQLite-backed append preserve their original closures without startup replay"
  )
  for (const row of used.manager.runtimeSessions().sessions.filter((row) => row.autoReclaimable))
    await used.run(row.threadId)
  const count = used.clients.length
  await assert.rejects(
    used.discover("fully-used-seven"),
    (error) => (error as { code?: string }).code === "MODS_SESSION_CAPACITY"
  )
  assert.equal(used.clients.length, count)
  assert.equal(live.size, 6)
  record(
    "six used real VMs remain protected and reject a seventh instead of replaying side effects"
  )
  await used.close()
  assert.equal(live.size, 0)
}

void app.whenReady().then(async () => {
  let error: unknown
  try {
    await acceptance()
  } catch (failure) {
    error = failure
    console.error(failure)
  } finally {
    for (const close of closeFixtures.reverse()) {
      try {
        await close()
      } catch (failure) {
        error ??= failure
        console.error(failure)
      }
    }
    const report = {
      status: error ? "failed" : "passed",
      checks,
      versions: { electron: process.versions.electron, node: process.versions.node },
      electronPid: process.pid,
      hostEntry,
      peakLiveChildren,
      children: facts,
      error: error instanceof Error ? error.stack : error ? String(error) : undefined,
      scope:
        "Production manager/runtime client test main and final built utility host; isolated native SQLite target and passthrough publication, no user app or model calls"
    }
    writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2))
    app.exit(error ? 1 : 0)
  }
})
