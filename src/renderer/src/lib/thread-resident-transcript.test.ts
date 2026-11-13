import { describe, expect, it } from "vitest"
import { parseThreadDirectoryChange } from "../../../shared/thread-directory-change"
import { rendererThreadDirectoryScope, sameThreadDirectoryScope } from "./thread-directory-scope"
import {
  rendererTranscriptSourceScope,
  sameTranscriptIncarnation,
  ThreadResidentTranscripts,
  isInvalidTranscriptSourceError
} from "./thread-resident-transcript"

const scope = (token: string, workspacePath?: string) => ({ threadId: "A",
  incarnation: { token, legacyCreatedAt: 1 }, ...(workspacePath ? { workspacePath } : {}) })

describe("resident transcript scopes", () => {
  it("supports ordinary rows without workspace without inventing an execution proof", () => {
    expect(rendererTranscriptSourceScope({ thread_id: "A", created_at: new Date(1) }))
      .toEqual({ threadId: "A", incarnation: { token: null, legacyCreatedAt: 1 } })
    expect(rendererTranscriptSourceScope({ thread_id: "A", created_at: new Date(NaN) }))
      .toBeUndefined()
  })

  it("accepts workspace changes in the same incarnation but rejects same-id replacement", () => {
    const registry = new ThreadResidentTranscripts()
    const owner = registry.enter("A", scope("old", "C:/one"))
    expect(registry.acceptPage("A", scope("old", "C:/one"), true)).toBe(true)
    expect(registry.acceptPage("A", scope("old", "C:/two"), false)).toBe(true)
    expect(owner.scope?.workspacePath).toBe("C:/two")
    expect(registry.acceptPage("A", scope("new"), false)).toBe(false)
    expect(owner.scope?.incarnation.token).toBe("old")
    expect(sameTranscriptIncarnation(scope("old", "C:/one"), scope("old", "C:/two"))).toBe(true)
  })

  it("permits exactly one legacy first page per empty resident, never an incremental merge", () => {
    const registry = new ThreadResidentTranscripts()
    registry.enter("A", scope("old"))
    expect(registry.acceptPage("A", undefined, true)).toBe(true)
    expect(registry.acceptPage("A", undefined, false)).toBe(false)
    expect(registry.acceptPage("A", undefined, true)).toBe(false)
    registry.forget("A")
    registry.enter("A", undefined)
    expect(registry.acceptPage("A", undefined, true)).toBe(true)
    expect(registry.acceptPage("A", scope("new"), false)).toBe(false)
  })

  it("does not accept a well-formed scope from another thread", () => {
    const registry = new ThreadResidentTranscripts()
    registry.enter("A", scope("old"))
    expect(registry.acceptPage("A", { ...scope("old"), threadId: "B" }, true)).toBe(false)
  })

  it("keeps background dirty until the captured owner/version actually succeeds", () => {
    const registry = new ThreadResidentTranscripts()
    const owner = registry.enter("A", scope("old"))
    registry.invalidate("unopened")
    expect(registry.get("unopened")).toBeUndefined()
    registry.invalidate("A")
    const readVersion = owner.dirty
    registry.invalidate("A")
    registry.complete("A", owner, readVersion)
    expect(owner.completed).toBe(1)
    expect(owner.dirty).toBe(2)
    const replacement = registry.enter("A", scope("new"))
    registry.invalidate("A")
    registry.complete("A", owner, 999)
    expect(replacement.completed).toBe(0)
    registry.invalidate()
    expect(replacement.dirty).toBe(2)
  })

  it("forgets old data scope and dirty flags on local removal and dehydration", () => {
    const registry = new ThreadResidentTranscripts()
    registry.enter("A", scope("old"))
    registry.invalidate("A")
    registry.forget("A")
    registry.invalidate()
    expect(registry.get("A")).toBeUndefined()
    const owner = registry.enter("A", scope("new"))
    expect(owner.dirty).toBe(0)
    expect(registry.acceptPage("A", scope("new"), true)).toBe(true)
  })

  it("fences exact owner replacement, same-owner hydration and absent-owner ABA", () => {
    const registry = new ThreadResidentTranscripts()
    let generation: number | undefined
    const absent = registry.capture("A", () => generation)
    expect(absent()).toBe(false)
    registry.enter("A", scope("old"))
    generation = 1
    const old = registry.capture("A", () => generation)
    generation++
    expect(old()).toBe(false)
    const previous = registry.capture("A", () => generation)
    registry.enter("A", scope("old"))
    expect(previous()).toBe(false)
    registry.forget("A")
    generation++
    expect(absent()).toBe(false)
  })

  it("consumes a legacy bootstrap continuation once and fences pending owner/generation", () => {
    const registry = new ThreadResidentTranscripts()
    let generation = 1
    registry.enter("A", scope("old"))
    const continuation = registry.captureLegacyBootstrap("A", () => generation)
    expect(continuation()).toBe(true)
    expect(continuation()).toBe(false)
    const oldHydration = registry.captureLegacyBootstrap("A", () => generation)
    generation++
    expect(oldHydration()).toBe(false)
    const oldOwner = registry.captureLegacyBootstrap("A", () => generation)
    registry.enter("A", scope("new"))
    expect(oldOwner()).toBe(false)
    expect(registry.captureLegacyBootstrap("unopened", () => generation)()).toBe(false)
  })

  it("matches only complete host source errors and Electron's exact channel envelope", () => {
    const code = "MODS_CONVERSATION_DISPLAY_SOURCE_INVALID"
    for (const channel of ["threads:messages-page", "threads:bootstrap-legacy-checkpoint-transcript"] as const) {
      expect(isInvalidTranscriptSourceError(new Error(code), channel)).toBe(true)
      expect(isInvalidTranscriptSourceError(new Error(
        `Error invoking remote method '${channel}': Error: ${code}`), channel)).toBe(true)
      for (const value of [code, { message: code }, new Error(`body contains ${code}`),
        new Error("network failed", { cause: new Error(code) }), new Error("MODS_CONVERSATION_THREAD_CHANGED"),
        new Error(`Error invoking remote method 'unrelated-channel': Error: ${code}`),
        new Error(`${code}: arbitrary detail`), new Error(`private body\n${code}`)]) {
        expect(isInvalidTranscriptSourceError(value, channel)).toBe(false)
      }
    }
  })
})

it("keeps known absent workspace scoped for transcripts but never for Mods directory scope", () => {
  const row = { thread_id: "A", created_at: new Date(1) }
  const transcript = rendererTranscriptSourceScope(row)
  expect(transcript).toBeDefined()
  expect(rendererThreadDirectoryScope(row)).toBeUndefined()
  const hint = parseThreadDirectoryChange({ threadId: "A", kind: "transcript",
    workspacePath: undefined, incarnation: { token: null, legacyCreatedAt: 1 } })
  expect(hint).toBeDefined()
  const workspace = { ...hint!, workspacePath: "C:/workspace" }
  expect(sameThreadDirectoryScope(workspace, hint)).toBe(false)
  expect(sameThreadDirectoryScope(hint, workspace)).toBe(false)
  expect(sameThreadDirectoryScope(hint, hint)).toBe(false)
  expect(sameThreadDirectoryScope(workspace, { ...workspace, workspacePath: "c:\\workspace" }))
    .toBe(true)
  const residents = new ThreadResidentTranscripts()
  const a = residents.enter("A", transcript), b = residents.enter("B", undefined)
  residents.invalidate(hint?.threadId)
  expect(a.dirty).toBe(1)
  expect(b.dirty).toBe(0)
  residents.invalidate()
  expect(a.dirty).toBe(2)
  expect(b.dirty).toBe(1)
})
