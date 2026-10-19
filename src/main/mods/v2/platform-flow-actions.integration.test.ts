import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { afterEach, expect, it } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import { ClawStore } from "../claw-store"
import { FlowManager } from "../flows/manager"
import { FlowStore } from "../flows/store"
import { resolveClawActionInput, type ClawActionEnvelope } from "../../../shared/mods/claw-actions"
import type { FlowRun } from "../../../shared/mods/flows/types"
import type { ModJson } from "../../../shared/mods/types"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
const envelope: ClawActionEnvelope = {
  version: 1,
  input: { file: "orders.ts" },
  config: {},
  task: "Review actual outputs",
  runId: "run",
  stepId: "step",
  executionId: "execution"
}

async function fixture(mode = "normal") {
  const workspace = await mkdtemp(join(tmpdir(), "platform-flow-actions-"))
  const sources: Array<{ id: string; name: string; path: string; enabled: boolean }> = []
  for (const name of ["producer", "reviewer"]) {
    const root = join(workspace, name)
    await mkdir(join(root, "hooks"), { recursive: true })
    await writeFile(
      join(root, "plugin.json"),
      JSON.stringify({
        name,
        version: "1.0.0",
        claw: {
          actions: [
            {
              id: "run",
              name: `${name} actual action`,
              platform: {
                id: "delivery",
                version: mode === "wrong-version" ? "2.0.0" : "1.0.0",
                action: mode === "wrong-action" ? "not-exported" : "run"
              },
              inputSchema: {
                type: "object",
                properties: { file: { type: "string" } },
                required: ["file"]
              },
              outputSchema: {
                type: "object",
                properties: { provider: { type: "string" } },
                required: ["provider"]
              }
            }
          ]
        }
      })
    )
    await writeFile(join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(
      join(root, "hooks/register.ts"),
      `export function register(on) {
      on.capability({ apiVersion:"devclaw.capability/v1", id:"delivery",version:"1.0.0",
        title:"${name}",scope:"conversation",stateSchema:{type:"object"},
        actions:["run","hidden"].map(id=>({id,title:id,inputSchema:{type:"object"},
          outputSchema:{type:"object"},requiredPermissions:["store.get","store.set"],
          cancellable:true,idempotency:"keyed"})) },{
        act:async($,event)=>{
          const count=Number(await $.store.get("flow-count")||0)+1;await $.store.set("flow-count",count);
          return {status:${JSON.stringify(mode === "running" ? "running" : mode === "failed" ? "failed" : "succeeded")},
            text:"${name}:"+event.input.input.file,
            output:{provider:"${name}",file:event.input.input.file,received:event.input.input,
              executionId:event.input.executionId,count}}
        }
      })
    }`
    )
    sources.push({ id: name, name, path: root, enabled: true })
  }
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  let loads = 0
  let publish = async (value: ModJson): Promise<ModJson> => value
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      publish: async (_workspace, value) => publish(value)
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          owned.push(guest)
          return guest
        },
        stop() {
          owned.forEach((guest) => guest.dispose())
        },
        async stopAndDrain() {
          owned.forEach((guest) => guest.dispose())
        }
      }
    }
  )
  closes.push(async () => {
    manager.close()
    guests.forEach((guest) => guest.dispose())
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  for (const source of await manager.status(workspace))
    await manager.approve(workspace, source.pluginId, source.digest!)
  return {
    workspace,
    store,
    manager,
    loads: () => loads,
    setPublish: (next: typeof publish) => {
      publish = next
    }
  }
}

it("discovers explicit platform exports without executing a guest, then returns structured results once", async () => {
  const f = await fixture()
  const before = f.loads()
  const [first] = await f.manager.actionCatalog(f.workspace, "thread")
  expect(f.loads()).toBe(before)
  expect(first.platform).toEqual({ id: "delivery", version: "1.0.0", action: "run" })
  expect(first).not.toHaveProperty("command")
  const prepared = await f.manager.prepareAction(
    f.workspace,
    "thread",
    first,
    new AbortController().signal
  )
  expect(prepared.route).toBe("platform")
  const run = () =>
    f.manager.runAction(f.workspace, "thread", prepared, envelope, new AbortController().signal)
  const result = await run()
  expect(result).toMatchObject({
    passed: true,
    output: { provider: "producer", count: 1, file: "orders.ts", executionId: "execution" }
  })
  expect(await run()).toEqual(result)
  await expect(
    f.manager.runAction(
      f.workspace,
      "thread",
      prepared,
      { ...envelope, input: { file: "other.ts" } },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_PLATFORM_REQUEST_CONFLICT")
  await expect(
    f.manager.prepareAction(
      f.workspace,
      "thread",
      { ...first, actionId: "hidden" },
      new AbortController().signal
    )
  ).rejects.toThrow("CLAW_ACTION_NOT_EXPORTED")
})

it.each(["wrong-version", "wrong-action"])("rejects a %s platform binding", async (mode) => {
  const f = await fixture(mode)
  const [action] = await f.manager.actionCatalog(f.workspace, "thread")
  await expect(
    f.manager.prepareAction(f.workspace, "thread", action, new AbortController().signal)
  ).rejects.toThrow(/MODS_PLATFORM_CAPABILITY_UNKNOWN|CLAW_ACTION_PLATFORM_OWNER/)
})

it("rejects invalid business input, mutated preparation, changed runtime and revoked grants", async () => {
  const f = await fixture()
  const [action] = await f.manager.actionCatalog(f.workspace, "thread")
  const prepared = await f.manager.prepareAction(
    f.workspace,
    "thread",
    action,
    new AbortController().signal
  )
  await expect(
    f.manager.runAction(
      f.workspace,
      "thread",
      prepared,
      { ...envelope, input: {} },
      new AbortController().signal
    )
  ).rejects.toThrow()
  const forged = structuredClone(prepared)
  if (forged.route !== "platform") throw Error("wrong route")
  forged.platform.ref.provider = "reviewer"
  await expect(
    f.manager.runAction(f.workspace, "thread", forged, envelope, new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_CHANGED")
  f.manager.invalidate(f.workspace)
  await expect(
    f.manager.runAction(f.workspace, "thread", prepared, envelope, new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_CHANGED")
  f.manager.revoke(f.workspace, "producer")
  await expect(
    f.manager.prepareAction(f.workspace, "thread", action, new AbortController().signal)
  ).rejects.toThrow()
})

it("does not upgrade a background running receipt into flow completion", async () => {
  const f = await fixture("running")
  const [action] = await f.manager.actionCatalog(f.workspace, "thread")
  const prepared = await f.manager.prepareAction(
    f.workspace,
    "thread",
    action,
    new AbortController().signal
  )
  await expect(
    f.manager.runAction(f.workspace, "thread", prepared, envelope, new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_NOT_TERMINAL")
})

it("retains explicit business failure and protected output, and rejects late revoked publication", async () => {
  const f = await fixture("failed")
  const [action] = await f.manager.actionCatalog(f.workspace, "thread")
  const prepared = await f.manager.prepareAction(
    f.workspace,
    "thread",
    action,
    new AbortController().signal
  )
  f.setPublish(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("orders.ts", "[protected]"))
  )
  expect(
    await f.manager.runAction(
      f.workspace,
      "thread",
      prepared,
      envelope,
      new AbortController().signal
    )
  ).toMatchObject({ passed: false, output: { file: "[protected]" } })
  f.setPublish(async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.output)
      f.manager.revoke(f.workspace, "producer")
    return value
  })
  await expect(
    f.manager.runAction(
      f.workspace,
      "thread",
      prepared,
      { ...envelope, executionId: "late" },
      new AbortController().signal
    )
  ).rejects.toThrow()
})

it("requires platform providers to belong to the current applied composition", async () => {
  const f = await fixture()
  const [producer, reviewer] = await f.manager.actionCatalog(f.workspace, "thread")
  const profile = {
    id: "one",
    name: "Only producer",
    capabilities: [{ pluginId: producer.pluginId, name: producer.plugin, digest: producer.digest }]
  }
  new ClawStore(f.store).write(
    f.workspace,
    { revision: 0, profiles: [profile], active: profile },
    0
  )
  await expect(
    f.manager.prepareAction(f.workspace, "thread", reviewer, new AbortController().signal)
  ).rejects.toThrow("CLAW_ACTION_PROVIDER_CHANGED")
})

it("runs two real platform providers through the existing sequential Flow manager and final approval", async () => {
  const f = await fixture()
  const threadId = randomUUID()
  const catalog = await f.manager.actionCatalog(f.workspace, threadId)
  const flow = new FlowManager(new FlowStore(f.store), {
    assertScope() {
      // The fixture uses one immutable workspace and thread scope.
    },
    changed() {
      // Assertions read the persisted run directly instead of observing notifications.
    },
    async prepare(workspace, thread, run, signal) {
      const prepared = new Map(
        await Promise.all(
          run.flow.definition.steps
            .filter((step) => step.kind === "plugin-action")
            .map(async (step) => {
              if (step.kind !== "plugin-action") throw Error("wrong step")
              return [
                step.id,
                await f.manager.prepareAction(workspace, thread, step, signal)
              ] as const
            })
        )
      )
      return {
        assertLive() {
          // Current grant and source checks are performed by the real manager below.
        },
        fingerprint: async () => "stable",
        dispose: async () => {},
        async execute(step, context) {
          if (step.kind !== "plugin-action") throw Error("wrong step")
          const prior =
            step.inputFrom &&
            context.run.attempts.findLast(
              (attempt) => attempt.stepId === step.inputFrom!.stepId && attempt.result?.output
            )
          const input = step.inputFrom
            ? resolveClawActionInput(step.input, prior!.result!.output!, step.inputFrom.path)
            : step.input
          const result = await f.manager.runAction(
            workspace,
            thread,
            prepared.get(step.id)!,
            {
              version: 1,
              input,
              config: step.config ?? {},
              task: run.flow.definition.goal,
              runId: run.id,
              stepId: step.id,
              executionId: context.executionId
            },
            context.signal
          )
          return {
            passed: result.passed ?? true,
            summary: result.text,
            source: "plugin-action",
            output: result.output
          }
        },
        async finalize(_context, confirm) {
          await confirm()
          return { passed: true, summary: "Reviewed", source: "host" }
        }
      }
    }
  })
  const saved = flow.save(
    f.workspace,
    {
      schemaVersion: 2,
      execution: { kind: "host" },
      id: "platform-sequence",
      name: "Platform sequence",
      goal: "Read and review",
      timeoutMs: 10000,
      maxExecutions: 8,
      steps: [
        ...catalog.map((action, index) => ({
          id: `step-${index}`,
          name: action.name,
          kind: "plugin-action",
          enabled: true,
          pluginId: action.pluginId,
          plugin: action.plugin,
          digest: action.digest,
          actionId: action.actionId,
          input: index ? {} : { file: "orders.ts" },
          ...(index ? { inputFrom: { stepId: "step-0" } } : {})
        })),
        {
          id: "review",
          name: "Review actual output",
          kind: "approval",
          enabled: true,
          prompt: "Review the two actual platform results"
        }
      ]
    },
    0
  )
  const started = await flow.start(f.workspace, threadId, saved.definition.id, saved.revision)
  let current: FlowRun | null = null
  await expect
    .poll(() => {
      current = flow.run(f.workspace, threadId, started.id)
      return current?.status
    })
    .toBe("waiting")
  expect(current!.attempts.filter((attempt) => attempt.status === "passed")).toHaveLength(2)
  expect(current!.attempts[1].result?.output).toMatchObject({
    provider: "reviewer",
    received: { provider: "producer" }
  })
  await flow.decide(f.workspace, threadId, started.id, current!.pendingApproval!.nonce, true)
  await flow.waitForSettlement(f.workspace, threadId, started.id)
  expect(flow.run(f.workspace, threadId, started.id)?.status).toBe("complete")
})
