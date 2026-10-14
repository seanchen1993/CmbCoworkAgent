import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionSessionAppendInput } from "../../../shared/mods/v2/session-append"
import { FunctionConversationStore } from "../../db/function-conversation-store"
import { createFunctionConversationTranscriptAccess } from "../../db/function-conversation-transcript"
import { captureThreadIncarnation } from "../../services/thread-incarnation"
import { ModRuntimeAuthorities } from "../runtime-instance"
import { FunctionConversationRegistry } from "./conversation-registry"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { FunctionSessionInitializer } from "./session-initializer"
import { FunctionSessionAppendTicket } from "./session-append-ticket"
import type { FunctionSessionAppendSource } from "./session-conversation-host"
import type { FunctionPlugin } from "./dispatcher"

const state = vi.hoisted(() => ({ path: "" }))
vi.mock("../../storage", () => ({ getDbPath: () => state.path,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn() }))
import * as threadDb from "../../db"

let directory = ""
const cleanups: Array<() => Promise<void> | void> = []
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "cmb-append-sdk-"))
  state.path = join(directory, "app.sqlite")
  await threadDb.initializeDatabase()
})
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
afterAll(async () => {
  await threadDb.closeDatabase()
  rmSync(directory, { recursive: true, force: true })
})

async function plugin(name: string, body: string): Promise<FunctionPlugin> {
  return { name, root: `/${name}`, tier: "user", capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`) }
}

async function fixture(body: string, options: Partial<FunctionSessionHost> = {},
  additional: FunctionPlugin[] = []) {
  const threadId = `append-sdk:${randomUUID()}`
  const thread = threadDb.createThread(threadId)
  const store = new FunctionConversationStore(threadDb.getDb())
  const authorities = new ModRuntimeAuthorities()
  const registry = new FunctionConversationRegistry(store, authorities)
  const owner = {}, controller = new AbortController()
  const ref = store.ensureMain({ threadId, workspace: "C:/append-sdk",
    incarnation: captureThreadIncarnation(thread), checkpointNamespace: "" }, () => {})
  const target = registry.registerMain(owner, { identity: {}, ref,
    checkpointThreadId: threadId, signal: controller.signal, assertCurrent: () => {} })
  const sources: Array<{ plugin: FunctionPlugin; source: FunctionSessionAppendSource }> = []
  const tickets: FunctionSessionAppendTicket[] = []
  const access = createFunctionConversationTranscriptAccess((_ref, row) => {
    const role = row.message.role ?? "system"
    if (role !== "user" && role !== "system") throw Error("Unexpected native note role")
    return { id: row.uuid, role, content: JSON.stringify(row.message.content),
      created_at: new Date(row.createdAt) }
  })
  const primary = await plugin("Q", body)
  const session = new FunctionSession([primary, ...additional], {
    threadId, workspace: "C:/append-sdk", assertLive: () => {}, publish: async value => value,
    appendSession: async (actualPlugin, args, source, run) => {
      sources.push({ plugin: actualPlugin, source })
      const mutation = { owner, plugin: actualPlugin, registration: source.identity,
        signal: source.signal, assertCurrent: source.assertCurrent }
      return registry.runMutation(mutation, target, "sdk", async (signal, guard) => {
        const input: FunctionSessionAppendInput = { uuid: randomUUID(), door: "note",
          origin: { kind: "plugin", name: actualPlugin.name }, message: {
            type: args.message.type, content: args.message.content,
            ...(args.message.type === "user" ? { role: "user", isMeta: true } : {}) } }
        let ticket: FunctionSessionAppendTicket
        ticket = new FunctionSessionAppendTicket({ kind: "sdk", input, target,
          source: mutation, signal, assertCurrent: guard, protect: async value => value,
          prepare: async safe => ({
            commit: check => store.commit(ref, { uuid: safe.uuid, inputDigest: ticket.inputDigest,
              door: safe.door, origin: safe.origin, message: safe.message,
              nativePayload: JSON.stringify({ content: safe.message.content, type: safe.message.type }),
              orderAnchor: { kind: "sdk-note" }, inbox: safe.message.type === "user", sdk: true },
            check, access.write, access.verify),
            read: () => {
              guard()
              const row = store.readReceipt(ref, safe.uuid)
              if (row) access.verify(threadDb.getDb(), ref, row)
              return row
            }
          }) })
        tickets.push(ticket)
        const result = await run(ticket)
        return ticket.acceptResult(result)
      })
    }, ...options
  })
  cleanups.push(() => { registry.close(); authorities.close() }, () => session.close())
  return { session, primary, sources, tickets, rows: () => threadDb.getThreadMessages(threadId),
    store, ref, controller }
}

const start = `on("session.start",async($,e,next)=>{
  await $.command.register({name:"note",description:"Note"});return next(e)
});`
const note = `{message:{type:"user",content:[{type:"text",text:"original"}]}}`
function resultText(value: ModObject): string {
  if (typeof value.text !== "string") throw Error("Actual command text missing")
  return value.text
}

it("uses a scalar real SQLite receipt, duplicate next once and caller-registration-only skip", async () => {
  const f = await fixture(`${start}let own=0;
    on("*",async($,e,next)=>{
      if(next.event==="command.run") {
        const row=await $.session.append(${note});return {text:JSON.stringify({row,own})};
      }
      if(next.event==="session.append")own++;
      return next(e);
    });
    on("session.append",async($,e,next)=>{
      const first=await next({...e,message:{...e.message,content:[{type:"text",text:"neighbor"}]}});
      const again=await next(e);if(first.uuid!==again.uuid)throw Error("two commits");return first;
    });`)
  const answer = JSON.parse(resultText(await f.session.run("note", "")))
  expect(answer.own).toBe(0)
  expect(answer.row.message.content).toEqual([{ type: "text", text: "neighbor" }])
  expect(Object.keys(answer.row).sort()).toEqual(["message", "uuid"])
  expect(f.rows()).toHaveLength(1)
  expect(f.sources[0].source.identity).toBe(f.primary.guest.registrations[1])
  expect(f.sources[0].source.registration).toBe(f.primary.guest.registrations[1])
  expect(f.tickets[0].committedRow?.uuid).toBe(answer.row.uuid)
})

it("does not treat forged success as commit evidence and preserves optional fallback", async () => {
  const f = await fixture(`${start}
    on("command.run",async($)=>({text:JSON.stringify(await $.session.append(${note}))}));
    on("session.append",async($,e)=>({uuid:e.uuid,message:e.message}));`)
  const answer = JSON.parse(resultText(await f.session.run("note", "")))
  expect(f.rows()).toHaveLength(1)
  expect(f.tickets[0].committedRow?.uuid).toBe(answer.uuid)
})

it("accepts only an SDK precommit deny without storing a note", async () => {
  const f = await fixture(`${start}
    on("command.run",async($)=>({text:JSON.stringify(await $.session.append(${note}))}));
    on("session.append",async()=>({deny:"declined"}));`)
  expect(await f.session.run("note", "")).toEqual({ text: '{"deny":"declined"}' })
  expect(f.rows()).toEqual([])
  expect(f.tickets[0].committedRow).toBeUndefined()
})

it("keeps a committed row when final protected ACK is changed and refuses false success", async () => {
  let scalarPublished = 0
  const f = await fixture(`${start}
    on("command.run",async($)=>{try{return {text:JSON.stringify(await $.session.append(${note}))}}
      catch(error){return {text:error.message}}});`, {
    publish: async (value: ModJson) => {
      if (value && typeof value === "object" && !Array.isArray(value) && value.uuid && value.message) {
        if (++scalarPublished >= 2) return { ...value, uuid: "forged-protected-uuid" }
      }
      return value
    }
  })
  expect((await f.session.run("note", "")).text).toContain("MODS_SESSION_APPEND_RESULT")
  expect(f.rows()).toHaveLength(1)
  expect(f.tickets[0].committedRow).toBeDefined()
})

it("rejects append in a strict candidate even when the guest catches the error", async () => {
  const initializer = new FunctionSessionInitializer(true)
  const append = vi.fn()
  const f = await fixture(`on("session.start",async($,e,next)=>{
    try{await $.session.append(${note})}catch{};return next(e)
  });`, { initializer, appendSession: append })
  await f.session.start()
  expect(() => initializer.assertReady()).toThrowError(expect.objectContaining({
    code: "MODS_CONFIG_RELOAD_EFFECT_UNSUPPORTED"
  }))
  expect(append).not.toHaveBeenCalled()
  expect(f.rows()).toEqual([])
})

it("routes received read selectors to the real backend while preserving the original SDK shape", async () => {
  const calls: unknown[] = []
  const f = await fixture(`${start}
    on("command.run",async($)=>({text:JSON.stringify(await $.session.messages({as:"api"}))}));
    on("session.messages",async($,e,next)=>next({...e,agentId:"actual-child"}));`, {
    readConversation: async (_plugin, args, signal, guard) => {
      guard(); signal.throwIfAborted(); calls.push(args)
      return [{ role: "user", content: [{ type: "document", source: { data: "full" } }] }]
    }
  })
  expect(JSON.parse(resultText(await f.session.run("note", "")))).toEqual([
    { role: "user", content: [{ type: "document", source: { data: "full" } }] }
  ])
  expect(calls).toEqual([{ as: "api", agentId: "actual-child" }])
  expect(f.rows()).toEqual([])
})

it("keeps engine-provider source identity stable across calls and separate from consumer Hooks", async () => {
  const provider = await plugin("P", `on("engine.create",async($,e,next)=>{
    const built=await next(e);return {...built,company:{save:async()=>built.session.append(${note})}};
  });`)
  const f = await fixture(`${start}on("command.run",async($)=>({text:JSON.stringify(await $.company.save({}))}));`,
    {}, [provider])
  await f.session.run("note", "")
  await f.session.run("note", "")
  expect(f.sources).toHaveLength(2)
  expect(f.sources[0].plugin).toBe(provider)
  expect(f.sources[0].source.identity).toBe(f.sources[1].source.identity)
  expect(f.sources[0].source.registration).toBeUndefined()
  expect(f.rows()).toHaveLength(2)
})

it("uses the stable actual timer resource after the creating Hook has returned", async () => {
  const f = await fixture(`${start}on("command.run",async($)=>{
    let ticks=0;const timer=$.clock.every(15,async()=>{
      await $.session.append(${note});if(++ticks===2)timer.cancel();
    });return {text:"scheduled"};
  });`)
  expect(await f.session.run("note", "")).toEqual({ text: "scheduled" })
  await vi.waitFor(() => expect(f.rows()).toHaveLength(2))
  expect(f.sources).toHaveLength(2)
  expect(f.sources[0].source.identity).toBe(f.sources[1].source.identity)
  expect(f.sources[0].source.registration).toBeUndefined()
  expect(f.sources[0].source.identity).not.toBe(f.primary.guest.registrations[1])
})

it("uses one native callback binding for two real presses without borrowing registration identity", async () => {
  const f = await fixture(`on("session.start",async($,e,next)=>{
    await $.ui.open({id:"notes",title:"Notes"});return next(e);
  });on("ui.render",($,e)=>$.ui.resolve(e).Button({key:"note",label:"Note",
    async onPress(){await $.session.append(${note})}
  }));`)
  await f.session.start()
  const [pane] = await f.session.panes.snapshot()
  if (!pane || pane.tree?.type !== "Button" || !pane.tree.press ||
    typeof pane.tree.press.handle !== "number")
    throw Error("Actual native callback missing")
  const handle = pane.tree.press.handle
  for (let index = 0; index < 2; index++) await f.session.panes.act({
    pane: pane.key, generation: pane.generation, intentId: randomUUID(), plugin: pane.plugin,
    kind: "press", handle
  })
  expect(f.rows()).toHaveLength(2)
  expect(f.sources).toHaveLength(2)
  expect(f.sources[0].source.identity).toBe(f.sources[1].source.identity)
  expect(f.sources[0].source.registration).toBeUndefined()
})

it("does not loosen the original API shape when a read Hook changes the requested form", async () => {
  const f = await fixture(`${start}
    on("command.run",async($)=>{try{await $.session.messages({as:"api"});return {text:"bad"}}
      catch(error){return {text:error.message}}});
    on("session.messages",async($,e,next)=>next({}));`, {
    readConversation: async (_plugin, args) => args.as === "api" ? [] :
      [{ role: "user", text: "summary", toolUses: [] }]
  })
  expect(resultText(await f.session.run("note", ""))).toContain("MODS_SESSION_APPEND_INVALID")
  expect(f.rows()).toEqual([])
})
