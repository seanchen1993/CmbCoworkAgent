import { expect, it } from "vitest"
import type { AgentViewIntent } from "../../../shared/mods/v2/agent-tasks"
import {
  activateModsAgentInput,
  releaseModsAgentInput,
  modsAgentInputActive,
  beginParentInputPreparation,
  reserveModsAgentInput,
  saveModsAgentDraft,
  readModsAgentDraft,
  captureModsAgentDraft,
  settleModsAgentDraft
} from "./mods-agent-input-target"

const intent: AgentViewIntent = {
  id: "one",
  threadId: "parent",
  workspace: "C:/project",
  agentId: "child",
  parentIncarnation: "birth",
  sourceDigest: "source",
  mode: "interactive"
}

it("keeps parent input targeting scoped and an old close cannot unlock a replacement intent", () => {
  activateModsAgentInput(intent, 1)
  expect(modsAgentInputActive("parent", 1)).toBe(true)
  expect(modsAgentInputActive("parent", 2)).toBe(false)
  expect(modsAgentInputActive("other", 1)).toBe(false)
  activateModsAgentInput({ ...intent, id: "replacement" }, 1)
  releaseModsAgentInput("one")
  expect(modsAgentInputActive("parent", 1)).toBe(true)
  releaseModsAgentInput("replacement")
  expect(modsAgentInputActive("parent", 1)).toBe(false)
})
it("preserves a reopened edited child draft when an older send receives its native receipt", () => {
  saveModsAgentDraft(intent, 1, "same words")
  const sent = captureModsAgentDraft(intent, 1)
  saveModsAgentDraft(intent, 1, "same words")
  settleModsAgentDraft(intent, 1, sent.version)
  expect(readModsAgentDraft(intent, 1)).toBe("same words")
  expect(readModsAgentDraft({ ...intent, sourceDigest: "replacement" }, 1)).toBe("")
  expect(readModsAgentDraft(intent, 2)).toBe("")
  settleModsAgentDraft(intent, 1, captureModsAgentDraft(intent, 1).version)
  expect(readModsAgentDraft(intent, 1)).toBe("")
})
it("reserves child input while an already claimed parent payload reaches transport handoff", async () => {
  const first = beginParentInputPreparation("parent", 1)!
  const reservation = reserveModsAgentInput(intent, 1)
  expect(beginParentInputPreparation("parent", 1)).toBeUndefined()
  expect(reservation.activate()).toBe(false)
  let ready = false
  const waiting = reservation.ready(new AbortController().signal).then(() => {
    ready = true
  })
  await Promise.resolve()
  expect(ready).toBe(false)
  first.release()
  await waiting
  expect(reservation.activate()).toBe(true)
  reservation.release()
})
it("cancels a pending input switch without aborting or losing the parent's claimed payload", async () => {
  const first = beginParentInputPreparation("parent", 1)!
  const reservation = reserveModsAgentInput(intent, 1),
    controller = new AbortController()
  const waiting = reservation.ready(controller.signal)
  controller.abort()
  await expect(waiting).rejects.toThrow("INPUT_TARGET_CHANGED")
  reservation.release()
  expect(activateModsAgentInput(intent, 1)).toBe(false)
  first.release()
  expect(activateModsAgentInput(intent, 1)).toBe(true)
  releaseModsAgentInput(intent.id)
})
it("an old waiter cannot release a replacement reservation for the same native intent", async () => {
  const old = reserveModsAgentInput(intent, 1)
  const current = reserveModsAgentInput(intent, 1)
  old.release()
  await current.ready(new AbortController().signal)
  expect(current.activate()).toBe(true)
  old.release()
  expect(modsAgentInputActive("parent", 1)).toBe(true)
  current.release()
})
