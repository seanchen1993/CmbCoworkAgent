import { expect, it } from "vitest"
import { captureThreadDirectoryChange } from "./thread-directory-change"

it("captures original row identity for commit-then-delete notification", () => {
  const row = {
    created_at: 1,
    metadata: JSON.stringify({ workspacePath: "/project", cmb_thread_incarnation: "native-token" })
  }
  const value = captureThreadDirectoryChange("thread", "deleted", row)
  row.metadata = JSON.stringify({ workspacePath: "/other", cmb_thread_incarnation: "new-token" })
  expect(value).toEqual({
    threadId: "thread",
    kind: "deleted",
    workspacePath: "/project",
    incarnation: { token: "native-token", legacyCreatedAt: 1 }
  })
})

it("keeps unknown rows and malformed metadata on the legacy full-invalidation path", () => {
  expect(captureThreadDirectoryChange("missing", "transcript", undefined)).toBeUndefined()
  for (const metadata of ["", "{", "null", "[]", "1", '"primitive"', "false",
    '{"workspacePath":null}', '{"workspacePath":" "}']) {
    expect(captureThreadDirectoryChange("thread", "metadata", { created_at: 1, metadata }))
      .toBeUndefined()
  }
  expect(captureThreadDirectoryChange("thread", "metadata", { created_at: NaN, metadata: "{}" }))
    .toBeUndefined()
})

it.each([null, "{}", '{"cmb_thread_incarnation":"native-token"}'])(
  "captures complete ordinary no-workspace hints for metadata %j", metadata => {
    const hint = captureThreadDirectoryChange("thread", "metadata", { created_at: 1, metadata })
    expect(hint).toEqual({ threadId: "thread", kind: "metadata", workspacePath: undefined,
      incarnation: { token: metadata?.includes("native-token") ? "native-token" : null,
        legacyCreatedAt: 1 } })
    expect(Object.hasOwn(hint!, "workspacePath")).toBe(true)
    expect(Object.isFrozen(hint)).toBe(true)
  })
