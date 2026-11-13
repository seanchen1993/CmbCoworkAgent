import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it } from "vitest"
import { isOrdinaryFlowMetadata } from "../../../shared/mods/flows/scope"
import { canUseChatWorkbench } from "./chat-workbench-visibility"

const file = ts.createSourceFile(
  "ChatContainer.tsx",
  readFileSync(resolve("src/renderer/src/components/chat/ChatContainer.tsx"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)
let enabled: ts.Expression | undefined
let visible: ts.Expression | undefined
function isClawSidebar(expression: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression
  return (
    (ts.isJsxElement(expression) &&
      expression.openingElement.tagName.getText(file) === "ClawSidebar") ||
    (ts.isJsxSelfClosingElement(expression) && expression.tagName.getText(file) === "ClawSidebar")
  )
}
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(file) === "useChatFlow")
    enabled = node.arguments[2]
  if (ts.isConditionalExpression(node) && isClawSidebar(node.whenTrue)) visible = node.condition
  ts.forEachChild(node, visit)
}
visit(file)

function evaluate(
  expression: ts.Expression | undefined,
  metadata: object,
  extra: { surface?: string; readOnly?: boolean; modsChatEnabled?: boolean } = {}
) {
  if (!expression) throw Error("Production Flow entry guard missing")
  return runInNewContext(expression.getText(file), {
    currentThread: { metadata },
    isOrdinaryFlowMetadata,
    modsChatEnabled: true,
    readOnly: false,
    chatWorkbenchAvailable: canUseChatWorkbench(extra.surface ?? "default", { metadata }),
    ...extra
  })
}

it.each([
  { agentMode: "normal", harnessProjectSession: { projectId: "project", kind: "knowledge" } },
  { agentMode: "normal", harnessFeature: { projectId: "project", slug: "feature" } }
])("keeps the actual workbench hook and sidebar out of a local Harness session %j", (metadata) => {
  expect(isOrdinaryFlowMetadata(metadata)).toBe(true)
  expect(evaluate(enabled, metadata)).toBe(false)
  expect(evaluate(visible, metadata)).toBe(false)
})

it.each([{ agentMode: "normal" }, { agentMode: "normal", modsDevelopment: { mode: "creator" } }])(
  "preserves ordinary chat and creator workbench guards %j",
  (metadata) => {
    expect(evaluate(enabled, metadata)).toBe(true)
    expect(evaluate(visible, metadata)).toBe(true)
    expect(evaluate(enabled, metadata, { readOnly: true })).toBe(false)
    expect(evaluate(enabled, metadata, { modsChatEnabled: false })).toBe(false)
  }
)

it.each(["harness-project", "harness-feature-session"])(
  "keeps a project surface closed before its project metadata arrives: %s",
  (surface) => {
    expect(evaluate(enabled, { agentMode: "normal" }, { surface })).toBe(false)
    expect(evaluate(visible, { agentMode: "normal" }, { surface })).toBe(false)
  }
)

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
