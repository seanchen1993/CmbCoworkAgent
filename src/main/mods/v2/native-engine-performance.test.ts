import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { expect, it } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { functionEngineRefs } from "../../../shared/mods/v2/engine"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const enabled = process.env.CMB_MODS_NATIVE_ENGINE_PERF === "1"
const warmup = 5
const samples = 20
const iterations = warmup + samples

interface Sample {
  durationMs: number
  heapBeforeBytes: number
  heapAfterBytes: number
  publicationCalls: number
}

async function fixture(hook: string) {
  let live = true
  let publications = 0
  const clients: FunctionGuestRuntime[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",async($,e,next)=>{${hook}});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "native-performance",
        root: "/native-performance",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/performance-project",
      threadId: "native-engine-performance",
      assertLive() {
        if (!live) throw Error("fixture retired")
      },
      publish: async (value: ModJson) => {
        publications++
        // Controlled publication really runs on input refs, trees and final Client snapshots.
        // This isolates the drawing pipeline; it does not claim the production policy VM cost.
        return JSON.parse(
          JSON.stringify(value)
            .replaceAll("PRIVATE_BODY", "SAFE_BODY")
            .replaceAll("PRIVATE_TITLE", "SAFE_TITLE")
        ) as ModJson
      },
      checkClientModule(plugin, module) {
        if (plugin !== "native-performance" || module !== "client.js") throw Error("unapproved")
      },
      async loadClient(plugin, module) {
        if (plugin !== "native-performance" || module !== "client.js") throw Error("unapproved")
        const child = await FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP +
            `
          var __cmbSurfaceMod={default(p,s){return s.elements.Text({children:p.label})}}`,
          { plugin }
        )
        clients.push(child)
        return child
      }
    }
  )
  await session.start()
  return {
    session,
    guest,
    clients,
    publications: () => publications,
    async close() {
      await session.close()
      live = false
    }
  }
}

async function measure(
  label: string,
  f: Awaited<ReturnType<typeof fixture>>,
  render: (index: number) => Promise<FunctionPaneSnapshot>,
  validate: (pane: FunctionPaneSnapshot, index: number) => void
) {
  const records: Sample[] = []
  for (let index = 0; index < iterations; index++) {
    const heapBeforeBytes = process.memoryUsage().heapUsed
    const beforePublication = f.publications()
    const before = performance.now()
    const pane = await render(index)
    const durationMs = performance.now() - before
    const heapAfterBytes = process.memoryUsage().heapUsed
    validate(pane, index)
    expect(JSON.stringify(pane)).not.toContain("PRIVATE_BODY")
    expect(JSON.stringify(pane)).not.toContain("PRIVATE_TITLE")
    expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
    for (const client of f.clients) expect(client.stats).toMatchObject({ frames: 0, replies: 0 })
    expect(Number.isFinite(durationMs) && durationMs >= 0).toBe(true)
    if (index >= warmup)
      records.push({
        durationMs,
        heapBeforeBytes,
        heapAfterBytes,
        publicationCalls: f.publications() - beforePublication
      })
  }
  const sorted = records.map((row) => row.durationMs).sort((a, b) => a - b)
  return {
    label,
    warmup,
    samples,
    medianMs: (sorted[samples / 2 - 1] + sorted[samples / 2]) / 2,
    p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
    maxMs: sorted.at(-1),
    heap: {
      firstBeforeBytes: records[0].heapBeforeBytes,
      lastAfterBytes: records.at(-1)!.heapAfterBytes,
      maxAfterBytes: Math.max(...records.map((row) => row.heapAfterBytes)),
      maxIterationDeltaBytes: Math.max(
        ...records.map((row) => row.heapAfterBytes - row.heapBeforeBytes)
      ),
      note: "Node heapUsed without forced GC; not QuickJS heap or a leak/retained-size assertion"
    },
    guestCount: 1,
    physicalClientVms: f.clients.length,
    records
  }
}

it.skipIf(!enabled)(
  "measures isolated actual native drawing, protected refs and shared Client admission",
  async () => {
    const results: Awaited<ReturnType<typeof measure>>[] = []
    const active: Awaited<ReturnType<typeof fixture>>[] = []
    try {
      const native = await fixture("return next(e)")
      active.push(native)
      results.push(
        await measure(
          "fresh default Pane / one native core",
          native,
          async (index) => {
            native.session.panes.open("native-performance", {
              id: "default",
              title: `PRIVATE_TITLE_${index}`
            })
            return (await native.session.panes.snapshot())[0]
          },
          (pane) => {
            expect(pane.tree.type).toBe("engine")
            expect(pane.nativeContent?.component).toBe("Pane")
            expect(pane.nativeContent?.entries).toHaveLength(2)
            expect(pane.title).toContain("SAFE_TITLE")
          }
        )
      )

      const boxed = await fixture(`const {Box}= $.ui.resolve(e);const children=[];
      for(let i=0;i<16;i++)children.push(await next({...e,props:{...e.props,text:e.props.text+":"+i}}));
      let tree=Box({children});for(let i=0;i<8;i++)tree=Box({children:[tree]});return tree`)
      active.push(boxed)
      const boxOwner = await boxed.session.sites.mount("UserMessage", "performance-message")
      results.push(
        await measure(
          "fresh UserMessage / 16 real refs / nine nested Boxes",
          boxed,
          (index) =>
            boxed.session.sites.render(boxOwner, {
              text: `PRIVATE_BODY_${index}`,
              isExpanded: true
            }),
          (pane) => {
            expect(functionEngineRefs(pane.tree)).toHaveLength(16)
            expect(pane.nativeContent?.entries).toHaveLength(17)
            expect(pane.nativeContent?.entries[0].props.origin).toEqual({ kind: "unclassified" })
          }
        )
      )

      // FunctionDispatcher caps actual core invocations at 32 for the entire chain, not only
      // each guest frame. Two Hook layers would still not reach the native drawing's 64-ref cap.
      const bounded = await fixture(`const {Box}= $.ui.resolve(e);const children=[];
      for(let i=0;i<32;i++)children.push(await next({...e,props:{...e.props,text:e.props.text+":"+i}}));
      return Box({children})`)
      active.push(bounded)
      const boundOwner = await bounded.session.sites.mount("AssistantMessage")
      const facts = (index: number): ModObject => ({
        text: `PRIVATE_BODY_${index}`,
        isFirstOfReply: true
      })
      results.push(
        await measure(
          "fresh AssistantMessage / actual dispatch limit of 32 native core refs",
          bounded,
          (index) => bounded.session.sites.render(boundOwner, facts(index)),
          (pane) => {
            expect(functionEngineRefs(pane.tree)).toEqual(
              Array.from({ length: 32 }, (_, i) => i + 1)
            )
            expect(pane.nativeContent?.entries).toHaveLength(33)
          }
        )
      )
      results.push(
        await measure(
          "cached same-generation 32 refs / publication still runs",
          bounded,
          () => bounded.session.sites.render(boundOwner, facts(iterations - 1)),
          (pane) => {
            expect(functionEngineRefs(pane.tree)).toEqual(
              Array.from({ length: 32 }, (_, i) => i + 1)
            )
            expect(pane.nativeContent?.entries).toHaveLength(33)
          }
        )
      )

      const client =
        await fixture(`const {Box,Client}= $.ui.resolve(e);const children=[await next(e)];
      for(let i=0;i<8;i++)children.push(Client({key:"client-"+i,module:"client.js",props:{label:e.props.title}}));
      return Box({children})`)
      active.push(client)
      results.push(
        await measure(
          "fresh Pane / eight physical Client VMs and admission",
          client,
          async (index) => {
            client.session.panes.open("native-performance", {
              id: "client-boundary",
              title: `PRIVATE_TITLE_${index}`
            })
            const pane = (await client.session.panes.snapshot())[0]
            expect(() =>
              client.session.clients.prepareReconcile("ninth", "ninth", randomUUID(), {
                type: "Client",
                props: { key: "ninth", module: "client.js", props: {} },
                client: { plugin: "native-performance" }
              })
            ).toThrow("MODS_CLIENT_LIMIT")
            return pane
          },
          (pane) => {
            expect(pane.clients).toHaveLength(8)
            expect(pane.clients!.every((row) => row.error === undefined)).toBe(true)
            expect(client.clients).toHaveLength(8)
            expect(client.clients.every((row) => !row.stats.disposed)).toBe(true)
          }
        )
      )
      await client.session.panes.closePane("native-performance", "client-boundary")
      await expect.poll(() => client.clients.every((row) => row.stats.disposed)).toBe(true)

      const report = {
        scope:
          "Actual local FunctionSession + QuickJS ui.render + FunctionUiSites/FunctionPanes + native ref protection + Client preflight/adoption/draw. Controlled publication callback; no utility IPC, production policy VM, renderer/OS paint, network/model or Electron timing.",
        enable: "CMB_MODS_NATIVE_ENGINE_PERF=1; this test is skipped by default",
        nativeRefBound:
          "The actual dispatcher permits 32 total core calls per chain. This workload measures 32 real refs plus ref0, not the separate native drawing capacity of 64 new refs. The first 64-next fixture failure is retained in mods-native-engine-isolated-performance-first.log; no production budget is relaxed.",
        timing:
          "render/admission awaits only; post-result content, frame and heap assertions outside timer; eight-Client cold loads are warmup, later VM reuse is timed",
        environment: {
          node: process.version,
          platform: process.platform,
          architecture: process.arch
        },
        results
      }
      await mkdir(resolve("output"), { recursive: true })
      await writeFile(
        resolve("output/mods-native-engine-isolated-performance.json"),
        JSON.stringify(report, null, 2) + "\n"
      )
      console.log(JSON.stringify(report))
    } finally {
      for (const f of active.reverse()) await f.close()
    }
  },
  120000
)
