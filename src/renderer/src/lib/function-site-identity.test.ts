import { createElement, isValidElement } from "react"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { functionSiteRowIdentity } from "./function-site-identity"
import { functionSitePresentationKey } from "./function-site-presentation"
import { FunctionCommandOutput } from "../components/chat/FunctionCommandOutput"
import { FunctionToolGroup } from "../components/chat/FunctionToolGroup"
import { FunctionToolDisplay } from "../components/chat/FunctionToolDisplay"
import type { ModObject } from "../../../shared/mods/types"

function siteProps(value: unknown) {
  if (!isValidElement<{ presentationId?: string; component: string; facts: ModObject }>(value))
    throw Error("Expected real FunctionSite element")
  return value.props
}
const call = (id: string) => ({
  tool_use_id: id,
  tool: "execute",
  input: { command: "PRIVATE_ARG" },
  output: "PRIVATE_OUTPUT",
  isRunning: false,
  isErrored: false,
  isInterrupted: false
})

it("keys command output by durable job and output channel, independent of text/status/command", () => {
  const props = {
    threadId: "thread",
    jobId: "native-job",
    command: "first-command",
    text: "PRIVATE_TEXT",
    isErrored: false,
    fallback: null,
    renderText: (text: string) => createElement("pre", {}, text)
  }
  const first = siteProps(FunctionCommandOutput(props))
  const progress = siteProps(
    FunctionCommandOutput({ ...props, command: "second-command", text: "changed", isErrored: true })
  )
  const error = siteProps(FunctionCommandOutput({ ...props, channel: "error" }))
  const other = siteProps(FunctionCommandOutput({ ...props, jobId: "other-job" }))
  expect(first.presentationId).toBe(progress.presentationId)
  expect(error.presentationId).not.toBe(first.presentationId)
  expect(other.presentationId).not.toBe(first.presentationId)
  expect(JSON.parse(first.presentationId!)).toEqual(["CommandOutput", "native-job", "output"])
  expect(first.presentationId).not.toMatch(/PRIVATE|command/)
  expect(first.facts.args).toBe("***")
  expect(first.facts).not.toHaveProperty("jobId")
  expect(first.facts).not.toHaveProperty("channel")
  expect(
    siteProps(FunctionCommandOutput({ ...props, jobId: undefined })).presentationId
  ).toBeUndefined()
  expect(
    FunctionCommandOutput({ ...props, text: "x".repeat(10001), fallback: "large original" })
  ).toBe("large original")
})

it("preserves exact ordered tool IDs while replacing membership or order changes identity", () => {
  const props = {
    threadId: "thread",
    calls: [call("native-one"), call("native-two")],
    blocked: false,
    isActive: false,
    children: () => null
  }
  const first = siteProps(FunctionToolGroup(props))
  expect(JSON.parse(first.presentationId!)).toEqual(["ToolGroup", "native-one", "native-two"])
  const progress = siteProps(
    FunctionToolGroup({
      ...props,
      isActive: true,
      calls: props.calls.map((row) => ({ ...row, input: { command: "changed" }, output: "later" }))
    })
  )
  expect(progress.presentationId).toBe(first.presentationId)
  expect(
    siteProps(FunctionToolGroup({ ...props, calls: [...props.calls].reverse() })).presentationId
  ).not.toBe(first.presentationId)
  expect(
    siteProps(FunctionToolGroup({ ...props, calls: [call("native-one"), call("other")] }))
      .presentationId
  ).not.toBe(first.presentationId)
  expect(first.presentationId).not.toContain("PRIVATE")
})

it("keeps approval and oversized identities on the original native or owned paths", () => {
  const native = createElement("button", {}, "Native approval")
  const children = vi.fn(() => native)
  const props = {
    threadId: "thread",
    calls: [call("native")],
    blocked: true,
    isActive: false,
    children
  }
  expect(FunctionToolGroup(props)).toBe(native)
  expect(children).toHaveBeenCalledWith(false)
  const owned = siteProps(
    FunctionToolGroup({ ...props, blocked: false, calls: [call("x".repeat(2049))] })
  )
  expect(owned.component).toBe("ToolGroup")
  expect(owned.presentationId).toBeUndefined()
  expect(owned.facts.calls).toHaveLength(1)
  const detail = {
    threadId: "thread",
    component: "ToolUse" as const,
    toolCall: { id: "native", name: "execute", args: { command: "actual-command" } },
    status: "awaiting_approval" as const,
    needsApproval: true,
    fallback: native,
    renderDetails: () => null
  }
  expect(FunctionToolDisplay(detail)).toBe(native)
})

it("gives ToolUse and ToolResult separate stable display identities without changing tool authority", () => {
  const props = {
    threadId: "thread",
    toolCall: { id: "native-call", name: "execute", args: { command: "PRIVATE" } },
    status: "completed" as const,
    result: "PRIVATE_OUTPUT",
    fallback: null,
    renderDetails: () => null
  }
  const use = siteProps(FunctionToolDisplay({ ...props, component: "ToolUse" }))
  const result = siteProps(FunctionToolDisplay({ ...props, component: "ToolResult" }))
  expect(JSON.parse(use.presentationId!)).toEqual(["ToolUse", "native-call"])
  expect(JSON.parse(result.presentationId!)).toEqual(["ToolResult", "native-call"])
  expect(use.presentationId).not.toBe(result.presentationId)
  expect(use.facts.tool_use_id).toBe("native-call")
  expect(use.facts.tool).toBe("execute")
  expect(
    siteProps(
      FunctionToolDisplay({
        ...props,
        component: "ToolUse",
        toolCall: { ...props.toolCall, id: "x".repeat(2049) }
      })
    ).presentationId
  ).toBeUndefined()
})

it("does not let boundary or escaped IDs exceed either host or renderer metadata limits", () => {
  for (const ids of [
    [],
    [""],
    ["x".repeat(2048)],
    ["\\".repeat(900)],
    Array.from({ length: 33 }, () => "id")
  ])
    expect(functionSiteRowIdentity("ToolGroup", ids)).toBeUndefined()
  const identity = functionSiteRowIdentity(
    "ToolGroup",
    Array.from({ length: 32 }, (_, i) => `native-${i}`)
  )!
  expect(identity.length).toBeLessThanOrEqual(2048 - 64)
  expect(JSON.stringify(["ToolGroup", identity]).length).toBeLessThanOrEqual(2048)
})

it.each(["CommandOutput", "ToolGroup", "ToolUse", "ToolResult"] as const)(
  "retains %s display eligibility in the shared passive-site vocabulary",
  (component) => {
    expect(functionSitePresentationKey("thread", component, "native-id", "{}", 800)).toBeTruthy()
    expect(functionSitePresentationKey("thread", component, "x".repeat(2049), "{}", 800)).toBeNull()
  }
)
