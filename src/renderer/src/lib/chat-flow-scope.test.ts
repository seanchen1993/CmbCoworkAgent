import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it } from "vitest"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"

const file = ts.createSourceFile(
  "ChatContainer.tsx",
  readFileSync(resolve("src/renderer/src/components/chat/ChatContainer.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let enabled: ts.Expression | undefined
let visible: ts.Expression | undefined
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === "useChatFlow")
    enabled = node.arguments[2]
  if (ts.isConditionalExpression(node) && node.whenTrue.getText(file).startsWith("<ClawSidebar"))
    visible = node.condition
  ts.forEachChild(node, visit)
}
visit(file)

function evaluate(expression: ts.Expression | undefined, metadata: object, extra = {}) {
  if (!expression) throw Error("Production Flow entry guard missing")
  return runInNewContext(expression.getText(file), {
    currentThread: { metadata },
    isOrdinaryFlowMetadata,
    modsChatEnabled: true,
    readOnly: false,
    // A project surface must not independently block a trusted local binding.
    isProjectModeAgentContext: true,
    ...extra
  })
}

it.each([
  { agentMode: "normal", harnessProjectSession: { projectId: "project", kind: "knowledge" } },
  { agentMode: "normal", harnessFeature: { projectId: "project", slug: "feature" } }
])("allows the actual chat hook and sidebar in a local Harness session %j", (metadata) => {
  expect(evaluate(enabled, metadata)).toBe(true)
  expect(evaluate(visible, metadata)).toBe(true)
  expect(evaluate(enabled, metadata, { readOnly: true })).toBe(false)
  expect(evaluate(enabled, metadata, { modsChatEnabled: false })).toBe(false)
})

it.each([
  { agentMode: "normal", harnessFeature: { projectId: "p", slug: "f", runId: "controller" } },
  { agentMode: "normal", harnessFeature: {} },
  { agentMode: "normal", remoteThread: true },
  { agentMode: "normal", imDeliveryContext: {} },
  { agentMode: "workflow" },
  { agentMode: "coordinator" }
])("keeps both real renderer entry guards closed for unsupported metadata %j", (metadata) => {
  expect(evaluate(enabled, metadata)).toBe(false)
  expect(evaluate(visible, metadata)).toBe(false)
})
