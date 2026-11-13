import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { expect, it } from "vitest"
import { isFunctionDockedSite } from "../../../shared/mods/v2/sites"
import { functionSitePresentationIdentity, functionSitePresentationKey,
  functionSitePresentationKeyAtWidth } from "./function-site-presentation"

/** Exercise the actual production useMemo expressions with persistent React-like hook slots.
 * DOM/lifecycle behavior is independently covered by the FunctionSite browser suites.
 */
function expressions(file: string, functionName: string, names: string[]): string {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const fn = source.statements.find(node => ts.isFunctionDeclaration(node) &&
    node.name?.text === functionName) as ts.FunctionDeclaration
  const statements = fn.body!.statements.filter(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(value => ts.isIdentifier(value.name) &&
      names.includes(value.name.text)))
  expect(statements).toHaveLength(names.length)
  return statements.map(node => node.getText(source)).join("\n")
}
function hooks() {
  const slots: Array<{ dependencies: unknown[]; value: unknown }> = []
  let cursor = 0
  return {
    begin: () => { cursor = 0 },
    useMemo(factory: () => unknown, dependencies: unknown[]) {
      const index = cursor++, previous = slots[index]
      if (previous && dependencies.length === previous.dependencies.length &&
        dependencies.every((value, offset) => Object.is(value, previous.dependencies[offset])))
        return previous.value
      const value = factory()
      slots[index] = { dependencies: [...dependencies], value }
      return value
    }
  }
}

it("serializes full facts once through internal state and width renders, and hashes only changed input", () => {
  const hook = hooks(), window = { innerWidth: 800 }
  let serialized = 0, hashed = 0
  const body = expressions("../components/chat/FunctionSite.tsx", "FunctionSiteSurface",
    ["input", "inputKey", "presentationIdentity", "viewportWidth", "inputPresentationIdentity", "presentationKey"])
  const execute = vm.runInNewContext(ts.transpileModule(
    `(function({component,facts,geometry,threadId,presentationId,messageId}){${body};return {input,inputKey,presentationKey}})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    useMemo: hook.useMemo, window, isFunctionDockedSite,
    JSON: { stringify: (value: unknown) => { serialized++; return JSON.stringify(value) } },
    functionSitePresentationIdentity: (...args: Parameters<typeof functionSitePresentationIdentity>) => {
      hashed++; return functionSitePresentationIdentity(...args)
    }, functionSitePresentationKeyAtWidth
  })
  let facts = { text: "正文\ud800".repeat(20000), isFirstOfReply: true }
  let geometry = { bodyColumns: 80, maxRows: 8, offset: 0 }
  const render = () => { hook.begin(); return execute({ component: "AssistantMessage", facts,
    geometry, threadId: "thread", presentationId: "row" }) }
  const first = render()
  for (let state = 0; state < 12; state++) expect(render().inputKey).toBe(first.inputKey)
  geometry = { ...geometry, offset: 5 }; render()
  window.innerWidth = 900
  const resized = render()
  expect(serialized).toBe(1)
  expect(hashed).toBe(1)
  expect(resized.presentationKey).not.toBe(first.presentationKey)
  expect(resized.presentationKey).toBe(functionSitePresentationKey("thread", "AssistantMessage",
    "row", first.inputKey, 900))
  facts = { ...facts, isFirstOfReply: false }; const changed = render()
  expect(changed.inputKey).not.toBe(first.inputKey)
  facts = { ...facts, isFirstOfReply: true }; const restored = render()
  expect(restored.inputKey).toBe(first.inputKey)
  expect(serialized).toBe(3)
  expect(hashed).toBe(3)
})

it("includes every message-facts dependency, preserving role, expansion, first reply and exact text", () => {
  const hook = hooks()
  const body = expressions("../components/chat/FunctionMessageText.tsx", "FunctionMessageText", ["facts"])
  const execute = vm.runInNewContext(ts.transpileModule(
    `(function({role,text,isExpanded,isFirstOfReply}){${body};return facts})`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, { useMemo: hook.useMemo })
  const render = (changes = {}) => { hook.begin(); return execute({ role: "user", text: "\ud800",
    isExpanded: false, isFirstOfReply: true, ...changes }) }
  const first = render()
  expect(render()).toBe(first)
  expect(render({ isExpanded: true })).toMatchObject({ text: "\ud800", isExpanded: true })
  expect(render({ role: "assistant", isFirstOfReply: false })).toEqual({ text: "\ud800", isFirstOfReply: false })
  expect(render({ text: "\ufffd" }).text).not.toBe(first.text)
  expect(render()).not.toBe(first)
  expect(render()).toEqual(first)
})

it.each(["\ud800", "\udc00", "a\u0000b", "中文😀"])(
  "keeps split width-key assembly byte-compatible with the original exact UTF-16 key %#", text => {
    const input = JSON.stringify({ text, isFirstOfReply: true })
    const identity = functionSitePresentationIdentity("thread", "AssistantMessage", "row", input)
    for (const width of [0, 800, 900]) expect(functionSitePresentationKeyAtWidth(identity, width))
      .toBe(functionSitePresentationKey("thread", "AssistantMessage", "row", input, width))
  }
)
