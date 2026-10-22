import { expect, it } from "vitest"
import { validateFunctionDisplaySnapshot, type FunctionDisplaySnapshot } from "./display-snapshot"

const snapshot = (): FunctionDisplaySnapshot => ({
  scopeId: "opaque-native-scope",
  key: "exact-input-key",
  version: "source-policy-v1",
  expiresAt: 0,
  data: {
    component: "AssistantMessage",
    nativeContent: {
      component: "AssistantMessage",
      entries: [{ ref: 0, props: { text: "safe", isFirstOfReply: true } }]
    }
  }
})

it("accepts protected passive data without fabricating an owner or extending cache expiry", () => {
  const value = snapshot()
  expect(() => validateFunctionDisplaySnapshot(value, "AssistantMessage")).not.toThrow()
  expect(Object.keys(value).sort()).toEqual(["data", "expiresAt", "key", "scopeId", "version"])
})

it.each(["owner", "generation", "markdownLinks", "authority"])(
  "rejects an unexpected %s authority field",
  (key) => {
    const value = { ...snapshot(), [key]: "forged" }
    expect(() => validateFunctionDisplaySnapshot(value, "AssistantMessage")).toThrow(
      "MODS_DISPLAY_DATA_INVALID"
    )
  }
)

it("rejects mismatched components and native content before displaying anything", () => {
  expect(() => validateFunctionDisplaySnapshot(snapshot(), "UserMessage")).toThrow(
    "MODS_DISPLAY_DATA_INVALID"
  )
  const value = snapshot()
  value.data.nativeContent!.component = "UserMessage"
  expect(() => validateFunctionDisplaySnapshot(value, "AssistantMessage")).toThrow()
})

it("does not admit active Markdown callbacks or embedded Clients into a projection", () => {
  const value = snapshot()
  value.data.tree = {
    type: "Markdown",
    props: { key: "linked", text: "link" },
    press: { kind: "onLinkPress", plugin: "mod", handle: 1 }
  }
  expect(() => validateFunctionDisplaySnapshot(value, "AssistantMessage")).toThrow(
    "MODS_DISPLAY_DATA_ACTIVE"
  )
  value.data.tree = {
    type: "Client",
    props: { key: "widget", module: "widget.ts" },
    client: { plugin: "mod" }
  }
  expect(() => validateFunctionDisplaySnapshot(value, "AssistantMessage")).toThrow(
    "MODS_DISPLAY_DATA_ACTIVE"
  )
})
