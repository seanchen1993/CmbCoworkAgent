import { expect, it } from "vitest"
import { parseThreadDirectoryChange } from "./thread-directory-change"

const hint = {
  threadId: "thread",
  kind: "transcript",
  workspacePath: "/workspace",
  incarnation: { token: "host-issued-token", legacyCreatedAt: 1 }
}

it("clones a complete host scope without granting it any authority", () => {
  const parsed = parseThreadDirectoryChange(hint)
  expect(parsed).toEqual(hint)
  expect(parsed).not.toBe(hint)
  expect(parsed?.incarnation).not.toBe(hint.incarnation)
  expect(Object.isFrozen(parsed)).toBe(true)
})

it.each([
  undefined,
  {},
  { ...hint, threadId: "" },
  { ...hint, kind: "anything" },
  { threadId: hint.threadId, kind: hint.kind, incarnation: hint.incarnation },
  ...[null, 1, "", " ", "\0"].map(workspacePath => ({ ...hint, workspacePath })),
  { ...hint, incarnation: undefined },
  { ...hint, incarnation: { token: null } },
  { ...hint, incarnation: { token: null, legacyCreatedAt: NaN } },
  { ...hint, extra: true }
])("retains conservative fallback for incomplete hints %j", (value) => {
  expect(parseThreadDirectoryChange(value)).toBeUndefined()
})

it("does not invoke payload accessors", () => {
  const value = { ...hint }
  Object.defineProperty(value, "workspacePath", {
    get() {
      throw Error("must not run")
    },
    enumerable: true
  })
  expect(parseThreadDirectoryChange(value)).toBeUndefined()
})

it("keeps legacy creation identity distinct from a recreated native UUID", () => {
  const legacy = parseThreadDirectoryChange({
    ...hint,
    incarnation: { token: null, legacyCreatedAt: 1 }
  })
  expect(legacy?.incarnation).not.toEqual(parseThreadDirectoryChange(hint)?.incarnation)
})

it("distinguishes a complete known no-workspace hint from an absent field", () => {
  const value = { ...hint, workspacePath: undefined }
  const parsed = parseThreadDirectoryChange(value)
  expect(parsed).toEqual(value)
  expect(Object.hasOwn(parsed!, "workspacePath")).toBe(true)
  expect(Object.isFrozen(parsed)).toBe(true)
  expect(Object.isFrozen(parsed?.incarnation)).toBe(true)
  const { workspacePath: _workspace, ...missing } = value
  expect(parseThreadDirectoryChange(missing)).toBeUndefined()
})
