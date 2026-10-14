import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSharedWallCut } from "./shared-wall-cut"
import {
  FunctionUiResolveUtilityAssembly,
  type FunctionUiResolveUtilityRuntime
} from "./ui-resolve-utility-assembly"

const enabled = process.env.CMB_MODS_UI_RESOLVE_PERF === "1"
const samples = 12
const warmup = 2

it.skipIf(!enabled)(
  "measures isolated actual VM preparation and cached foreign constructors",
  async () => {
    const report: Record<string, unknown> = {}
    for (const kind of ["native", "unmatched", "composed"] as const) {
      const startup: number[] = []
      const render: number[] = []
      let matchingCalls = 0
      let foreignCredit = 0
      for (let sample = 0; sample < samples + warmup; sample++) {
        const started = performance.now()
        const guests: FunctionGuestRuntime[] = []
        let assembly: FunctionUiResolveUtilityAssembly | undefined
        try {
          const participants: FunctionUiResolveUtilityRuntime[] = []
          const add = async (name: string, body: string) => {
            const guest = await FunctionGuestRuntime.create(
              `globalThis.__cmbFunctionMod={register(on){${body}}};`
            )
            guests.push(guest)
            participants.push({
              runtimeId: name,
              guest,
              declaration: {
                runtimeId: name,
                name,
                root: "/" + name,
                tier: "user",
                modelProtocol: "result-v1",
                capabilities: ["ui.resolve"],
                registrations: [...guest.registrations]
              },
              assertCurrent() {
                if (guest.stats.disposed) throw new Error("actual VM disposed")
              }
            })
            return guest
          }
          const q = await add(
            "Q",
            `on("ui.render",($,e)=>{
          const first=$.ui.resolve(e),second=$.ui.resolve(e);
          if(first!==second||!Object.isFrozen(first))throw Error("cache identity changed");
          return first.Text({children:"native body"});
        });`
          )
          if (kind !== "native") {
            await add(
              "P",
              `on("ui.resolve",{component:/^${kind === "unmatched" ? "NEVER" : "Pane"}$/},
            async($,e,next)=>{const lower=await next(e);
            return {...lower,Text:p=>lower.Text({...p,children:"P body"})};});`
            )
          }
          let revision = 1
          let requests = 0
          let handles = 0
          assembly = new FunctionUiResolveUtilityAssembly({
            identity: Object.freeze({}),
            assembly: "performance-assembly",
            requestId: "performance-prepare",
            participants,
            credit: { revision, limits: { handles: 0, roots: 0, branches: 0, reactions: 0 } },
            startupCutNs: FunctionSharedWallCut.after(120000).expiresAtNs,
            signal: new AbortController().signal,
            host: {
              assertCurrent() {
                /* This isolated benchmark keeps the source fixed. */
              },
              publish() {
                /* Utility IPC is explicitly outside this benchmark. */
              },
              async call() {
                throw new Error("performance fixture must never request host SDK")
              },
              async requestCredit(limits) {
                requests++
                handles = limits.handles
                return { revision: ++revision, limits: { ...limits } }
              }
            }
          })
          const prepared = await assembly.prepare()
          assembly.adopt(prepared.preparedToken)
          const startupMs = performance.now() - started
          const renderStarted = performance.now()
          for (let drawing = 0; drawing < 20; drawing++) {
            const token = "performance-drawing-" + drawing
            const result = await q.invoke(
              "0",
              { surface: "desktop", component: "Pane", requestId: token, props: {} },
              async () => {
                throw new Error("ordinary host SDK must never run")
              },
              {
                event: "ui.render",
                plugin: { name: "Q", root: "/Q" },
                origin: { plugin: "host", tier: "core" },
                capabilities: ["ui.resolve"],
                uiGeneration: token,
                ownBudgetMs: 10000
              },
              { assembly: "performance-assembly", token }
            )
            expect(result.value).toEqual({
              type: "Text",
              props: {},
              children: [kind === "composed" ? "P body" : "native body"]
            })
            assembly.closeDrawing(token)
          }
          const renderMs = (performance.now() - renderStarted) / 20
          expect(requests > 0).toBe(kind === "composed")
          expect(handles > 0).toBe(kind === "composed")
          if (sample >= warmup) {
            startup.push(startupMs)
            render.push(renderMs)
          }
          matchingCalls = requests
          foreignCredit = handles
        } finally {
          assembly?.retire()
          for (const guest of guests.reverse()) guest.dispose()
        }
      }
      const measure = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b)
        expect(sorted.every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
        return {
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]
        }
      }
      report[kind] = {
        startup: measure(startup),
        cachedRender: measure(render),
        creditRequests: matchingCalls,
        handleCredit: foreignCredit
      }
    }
    writeFileSync(
      resolve("output/mods-ui-resolve-isolated-performance.json"),
      JSON.stringify(
        {
          warmup,
          samples,
          drawingsPerSample: 20,
          scope:
            "Actual QuickJS creation, fourteen components per VM and cached Pane constructor calls. cachedRender reports percentiles of twelve twenty-drawing batch means, not individual drawing latency. Excludes utility IPC, Main permissions/protection, React, OS paint and models.",
          report
        },
        null,
        2
      ) + "\n",
      "utf8"
    )
  },
  120000
)
