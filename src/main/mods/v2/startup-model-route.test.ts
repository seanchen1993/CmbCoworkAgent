import { expect, it } from "vitest"
import { FunctionStartupModelRoute } from "./startup-model-route"
import { withIndependentPromptFrame } from "./model-prompt-frame"
import type { ModIdentity } from "../../../shared/mods/types"
import type { FunctionSession } from "./session"

const identity = {
  workspace: "workspace",
  threadId: "thread",
  modId: "function:demo",
  grantEpoch: 1,
  turnId: "analysis",
  callId: "request",
  origin: "mod"
} as ModIdentity
function scope() {
  const session = {} as FunctionSession
  return {
    workspace: identity.workspace,
    threadId: identity.threadId,
    session,
    entry: {},
    assertLive: () => {},
    assertRequest: (request: Readonly<ModIdentity>) => {
      if (request.modId !== identity.modId || request.grantEpoch !== identity.grantEpoch)
        throw Error("WRONG_OWNER")
    }
  }
}

it("requires an actual identified model frame and rejects cross-thread or different grant requests", async () => {
  const route = new FunctionStartupModelRoute()
  expect(route.capturePrompt("workspace", "thread")).toBeUndefined()
  await route.run(scope(), async () => {
    expect(() => route.capturePrompt("workspace", "thread")).toThrow("REQUEST_REQUIRED")
    await withIndependentPromptFrame(async () => {
      expect(() => route.capturePrompt("workspace", "other")).toThrow("MODS_SCOPE_CHANGED")
      expect(route.capturePrompt("workspace", "thread")?.session).toBeDefined()
    }, identity)
    await withIndependentPromptFrame(
      async () => {
        expect(() => route.capturePrompt("workspace", "thread")).toThrow("WRONG_OWNER")
      },
      { ...identity, grantEpoch: 2 }
    )
  })
})

it("keeps the whole model guard after preparation while closing its prompt receipt and detached startup", async () => {
  const route = new FunctionStartupModelRoute()
  const release = Promise.withResolvers<void>()
  let later!: Promise<void>
  await route.run(scope(), async () => {
    const whole = route.captureGuard("workspace", "thread")!
    let prompt!: ReturnType<typeof route.capturePrompt>
    await withIndependentPromptFrame(async () => {
      prompt = route.capturePrompt("workspace", "thread")
      prompt!.assertLive()
    }, identity)
    whole()
    expect(() => prompt!.assertLive()).toThrow("REQUEST_EXPIRED")
    later = release.promise.then(() => {
      expect(() => whole()).toThrow("SCOPE_EXPIRED")
      expect(() => route.assertOrdinaryEntry("workspace", "thread", "commands")).toThrow(
        "SCOPE_EXPIRED"
      )
    })
  })
  release.resolve()
  await later
})

it("isolates concurrent actual requests and clears startup privileges for fresh background entries", async () => {
  const route = new FunctionStartupModelRoute()
  await route.run(scope(), async () => {
    await Promise.all(
      [1, 2].map(async (number) =>
        withIndependentPromptFrame(
          async () => {
            const proof = route.capturePrompt("workspace", "thread")!
            await Promise.resolve()
            proof.assertLive()
            expect(route.capturePrompt("workspace", "thread")).toBe(proof)
          },
          { ...identity, callId: "request-" + number }
        )
      )
    )
    expect(() => route.assertOrdinaryEntry("workspace", "thread", "commands")).toThrow(
      "组件启动期间不能再次进入"
    )
    route.assertOrdinaryEntry("workspace", "thread", "effectiveStatus")
    await route.fresh(async () => {
      expect(route.captureGuard("workspace", "thread")).toBeUndefined()
      route.assertOrdinaryEntry("workspace", "thread", "commands")
    })
  })
})
