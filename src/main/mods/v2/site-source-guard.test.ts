import { afterEach, expect, it, vi } from "vitest"
import { FunctionUiSites } from "./sites"
import type { PaneHost } from "./panes"
import type { UserInputRequest } from "../../types"

const opened: FunctionUiSites[] = []
afterEach(() => {
  for (const sites of opened.splice(0)) sites.close()
})

function fixture() {
  let live = true
  let publication: (() => void | Promise<void>) | undefined
  let question: Readonly<UserInputRequest> | null = null
  const host: PaneHost & { pendingQuestion(): Readonly<UserInputRequest> | null } = {
    plugins: [],
    assertLive() {
      if (!live) throw Error("source or grant revoked")
    },
    changed: vi.fn(),
    publish: async value => {
      await publication?.()
      return value
    },
    dispatch: async (_event, input, options) => options.core
      ? options.core(input, new AbortController().signal) : { type: "engine", ref: 0 },
    callback: async () => undefined,
    pendingQuestion: () => question
  }
  const sites = new FunctionUiSites(host)
  opened.push(sites)
  return {
    sites,
    revoke: () => { live = false },
    publish: (run: () => void | Promise<void>) => { publication = run },
    question: (value: Readonly<UserInputRequest>) => { question = value }
  }
}

const message = { text: "Original native message", isFirstOfReply: true }

it("checks source and grant again after native message publication awaits", async () => {
  const setup = fixture()
  const owner = await setup.sites.mount("AssistantMessage")
  await setup.sites.render(owner, message)
  setup.publish(setup.revoke)
  await expect(setup.sites.render(owner, message)).rejects.toThrow("source or grant revoked")
})

it("rejects a retired native owner at the next snapshot publication fence", async () => {
  const setup = fixture()
  const owner = await setup.sites.mount("AssistantMessage")
  await setup.sites.render(owner, message)
  setup.publish(() => setup.sites.retire(owner))
  await expect(setup.sites.render(owner, message)).rejects.toThrow("MODS_UI_DRAWING_STALE")
})

it("checks queued render authority when it executes after a suspended render", async () => {
  const setup = fixture()
  const owner = await setup.sites.mount("AssistantMessage")
  let entered = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  setup.publish(async () => { entered = true; await gate })
  const first = setup.sites.render(owner, message)
  await vi.waitFor(() => expect(entered).toBe(true))
  const queued = setup.sites.render(owner, message)
  const firstRejected = expect(first).rejects.toThrow("source or grant revoked")
  const queuedRejected = expect(queued).rejects.toThrow("source or grant revoked")
  setup.revoke()
  release()
  await Promise.all([firstRejected, queuedRejected])
})

it("retains exact AskUserQuestion request identity after publication awaits", async () => {
  const setup = fixture()
  const questions = [{ id: "choice", header: "Plan", question: "Continue?", options: [
    { label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }
  ] }]
  const request: UserInputRequest = { requestId: "original-request", threadId: "thread",
    createdAt: "2026-10-18T00:00:00.000Z", questions }
  setup.question(request)
  const owner = await setup.sites.mount("AskUserQuestion", undefined, request.requestId)
  setup.publish(() => setup.question({ ...request }))
  await expect(setup.sites.render(owner, { tool: "request_user_input", questions }))
    .rejects.toThrow("MODS_UI_QUESTION_STALE")
})
