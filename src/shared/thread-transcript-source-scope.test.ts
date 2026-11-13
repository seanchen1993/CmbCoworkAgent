import { expect, it, vi } from "vitest"
import {
  parseThreadTranscriptSourceScope,
  MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES
} from "./thread-transcript-source-scope"

const incarnation = { token: "host-incarnation", legacyCreatedAt: 1 }

it("keeps ordinary no-workspace page identity without manufacturing a workspace", () => {
  const input = { threadId: "ordinary", incarnation: { token: null, legacyCreatedAt: 0 } }
  const scope = parseThreadTranscriptSourceScope(input)
  expect(scope).toEqual(input)
  expect(scope).not.toBe(input)
  expect(scope?.incarnation).not.toBe(input.incarnation)
  expect(Object.hasOwn(scope!, "workspacePath")).toBe(false)
  expect(Object.isFrozen(scope)).toBe(true)
  expect(Object.isFrozen(scope?.incarnation)).toBe(true)
})

it("retains complete host facts separately from authority or directory event kinds", () => {
  expect(
    parseThreadTranscriptSourceScope({
      threadId: "thread",
      incarnation,
      workspacePath: "/workspace"
    })
  ).toEqual({ threadId: "thread", incarnation, workspacePath: "/workspace" })
  expect(
    parseThreadTranscriptSourceScope({ threadId: "thread", incarnation, kind: "transcript" })
  ).toBeUndefined()
})

it.each([
  undefined,
  {},
  { threadId: "thread" },
  { threadId: "", incarnation },
  { threadId: "thread", incarnation: { token: null } },
  { threadId: "thread", incarnation: { ...incarnation, legacyCreatedAt: NaN } },
  { threadId: "thread", incarnation: { ...incarnation, token: {} } },
  { threadId: "thread", incarnation, workspacePath: "" },
  { threadId: "thread", incarnation, workspacePath: "\0" },
  { threadId: "thread", incarnation, rawMessages: ["private"] }
])("leaves incomplete or unknown page scope on the legacy fresh-hydration path %j", (value) => {
  expect(parseThreadTranscriptSourceScope(value)).toBeUndefined()
})

it("does not invoke getters or coercions from a malformed scope", () => {
  const read = vi.fn(() => "/workspace")
  const input = { threadId: "thread", incarnation }
  Object.defineProperty(input, "workspacePath", { enumerable: true, get: read })
  expect(parseThreadTranscriptSourceScope(input)).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})

it("bounds the separately counted header even with maximal JSON escaping", () => {
  const input = {
    threadId: "\u0001".repeat(512),
    incarnation: { token: "\u0001".repeat(512), legacyCreatedAt: Number.MAX_VALUE },
    workspacePath: "\u0001".repeat(32768)
  }
  const scope = parseThreadTranscriptSourceScope(input)
  expect(scope).toEqual(input)
  const bytes = new TextEncoder().encode(JSON.stringify({ sourceScope: scope })).byteLength
  expect(bytes).toBeGreaterThan(190 * 1024)
  expect(bytes).toBeLessThanOrEqual(MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES)
  expect(scope?.workspacePath?.length).toBe(32768)
})

it("rejects an oversized header rather than truncating host identity fields", () => {
  const oversized = {
    threadId: "thread",
    incarnation,
    workspacePath: "\u0001".repeat(MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES)
  }
  expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(
    MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES
  )
  expect(parseThreadTranscriptSourceScope(oversized)).toBeUndefined()
  expect(oversized.workspacePath.length).toBe(MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES)
})
