import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionPeerInbox } from "./peer-inbox"
import { FunctionPeerLedger } from "./peer-ledger"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(receiverHook: string, senderHook = "") {
  const ledger = new FunctionPeerLedger(":memory:")
  cleanup.push(() => ledger.close())
  const inbox = new FunctionPeerInbox(ledger)
  cleanup.push(() => inbox.close())
  async function session(id: string, code: string) {
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${code}}}`)
    const result = new FunctionSession(
      [
        {
          name: id,
          root: "/plugin",
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace: "/project",
        threadId: id,
        assertLive() {
          /* This fixture retains its grant until teardown. */
        },
        publish: async (v) => v,
        sendPeer: async (plugin, input, signal) =>
          inbox.send(input, {
            workspace: "/project",
            sessionId: id,
            agentId: "main",
            plugin: plugin.name,
            signal,
            assertLive() {
              /* This fixture retains its grant until teardown. */
            },
            publish: async (text) => text
          })
      }
    )
    cleanup.push(() => result.close())
    return result
  }
  const receiver = await session("receiver", receiverHook)
  const endpoint = inbox.register({
    workspace: "/project",
    sessionId: "receiver",
    agentId: "main",
    assertLive() {
      /* This fixture retains its grant until teardown. */
    },
    receive: (input, commit, signal) => receiver.receivePeer(input, signal, commit)
  })
  const sender = await session(
    "sender",
    `
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"send",description:"send"});return next(e)
    });
    on("command.run",async($)=>{
      try{return await $.session.send({to:{sessionId:"receiver"},text:"original"})}
      catch(error){return {error:error.code}}
    });${senderHook}`
  )
  return { sender, endpoint, ledger }
}

it("uses send and receive hooks before a durable peer-only queue commit", async () => {
  const { sender, endpoint, ledger } = await fixture(
    `
    on("session.receive",async($,e,next)=>next({...e,text:e.text+" received"}));`,
    `
    on("session.send",async($,e,next)=>next({...e,text:e.text+" sent"}));`
  )
  expect(await sender.run("send", "")).toEqual({ isDelivered: true })
  const records = endpoint.claim()
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({
    text: "original sent received",
    plugin: "sender",
    fromSessionId: "sender",
    status: "processing",
    origin: "peer"
  })
  endpoint.settle(
    records.map((row) => row.id),
    "delivered"
  )
  expect(ledger.list("/project", "receiver")[0].status).toBe("delivered")
})

it("a consumed message is neither persisted nor delivered to the model inbox", async () => {
  const { sender, endpoint, ledger } = await fixture(
    `on("session.receive",async()=>({consumed:true}));`
  )
  expect(await sender.run("send", "")).toMatchObject({ isDelivered: false })
  expect(endpoint.claim()).toEqual([])
  expect(ledger.list("/project", "receiver")).toEqual([])
})

it("does not let hooks replace pinned plugin origin", async () => {
  const { sender, endpoint } = await fixture(
    "",
    `
    on("session.send",async($,e,next)=>{
      try{return await next({...e,origin:{kind:"plugin",name:"forged"}})}
      catch(error){return {isDelivered:false,reason:error.code}}
    });`
  )
  expect(await sender.run("send", "")).toMatchObject({
    isDelivered: false,
    reason: "MODS_PINNED_INPUT"
  })
  expect(endpoint.claim()).toEqual([])
})
