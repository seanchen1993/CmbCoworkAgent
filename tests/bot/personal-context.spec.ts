import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"
import ts from "typescript"
import {
  buildPersonalIdentityPrompt,
  isPersonalMemoryEnabled
} from "../../src/main/agent/personal-context"

test("shared tasks override enabled personal memory", () => {
  assert.equal(isPersonalMemoryEnabled({ sharedTaskContext: true }, true), false)
  assert.equal(isPersonalMemoryEnabled({ sharedTaskContext: true }, false), false)
})

test("existing personal memory preferences stay unchanged", () => {
  for (const policy of [{}, { sharedTaskContext: false }]) {
    assert.equal(isPersonalMemoryEnabled(policy, true), true)
    assert.equal(isPersonalMemoryEnabled(policy, false), false)
  }
})

test("shared tasks never read desktop identity", () => {
  assert.equal(
    buildPersonalIdentityPrompt({ sharedTaskContext: true }, () => {
      throw new Error("must not read personal identity")
    }),
    ""
  )
})

test("personal runtime keeps the previous identity format and lazy read count", () => {
  let reads = 0
  const prompt = buildPersonalIdentityPrompt({}, () => {
    reads += 1
    return { sapId: "s", ystId: "y", userName: "n", originOrgId: "o", orgName: "org", ystCode: "c" }
  })
  assert.equal(reads, 1)
  assert.equal(
    prompt,
    `## Current user's employee identity information
- sap编号、员工编号:s
- yst编号、一事通编号: y
- userName、员工姓名: n
- originOrgId、员工机构号: o
- orgName、员机构号名称: org
- ystCode、一事通code: c`
  )
  assert.match(
    buildPersonalIdentityPrompt({ sharedTaskContext: false }, () => null),
    /员工编号:undefined/
  )
})

const root = resolve(__dirname, "../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

// Wiring checks, not an assertion that a real model or group integration ran.
test("all four child Runtime factories inherit the trusted shared-task flag", () => {
  const source = ts.createSourceFile(
    "runtime.ts",
    read("src/main/agent/runtime.ts"),
    ts.ScriptTarget.Latest,
    true
  )
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "createAgentRuntime"
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(calls.length, 4, "review new child creation paths if the count changes")
  for (const call of calls) {
    const options = call.arguments[0]
    assert.ok(ts.isObjectLiteralExpression(options))
    assert.ok(
      options.properties.some(
        (property) =>
          ts.isShorthandPropertyAssignment(property) && property.name.text === "sharedTaskContext"
      )
    )
    const flagIndex = options.properties.findIndex(
      (property) =>
        ts.isShorthandPropertyAssignment(property) && property.name.text === "sharedTaskContext"
    )
    const lastSpreadIndex = options.properties.reduce(
      (last, property, index) => (ts.isSpreadAssignment(property) ? index : last),
      -1
    )
    // The ordinary leaf's only spread contains workspace isolation, not context overrides.
    if (call.getText(source).includes("...workerHarnessContext"))
      assert.ok(flagIndex > lastSpreadIndex)
  }
})

test("production prompt/memory initialization and post-run maintenance consume the privacy policy", () => {
  const runtime = read("src/main/agent/runtime.ts")
  assert.ok(runtime.includes("const memoryEnabledForThread = isPersonalMemoryEnabled("))
  assert.ok(runtime.includes("buildPersonalIdentityPrompt({ sharedTaskContext }, getUserInfo)"))
  assert.ok(!runtime.includes("const userInfo = getUserInfo()"))
  assert.ok(runtime.includes('if (userInfoPrompt) systemPrompt += "\\n\\n" + userInfoPrompt'))
  const desktop = read("src/main/ipc/agent.ts")
  assert.ok(
    desktop.includes("sharedTaskContext: runExecutionContext.remotePolicy?.sharedTaskContext")
  )
  assert.ok(desktop.includes("memoryEnabled: memoryEnabledForThread"))
  assert.ok(desktop.includes("if (!memoryEnabledForThread) return false"))
})

test("standard factory applies shared-task privacy after caller/harness options", () => {
  const shared = read("src/main/agent/standard-thread-turn.ts")
  assert.ok(
    shared.includes("policy.sharedTaskContext ? { sharedTaskContext: true, memoryEnabled: false }")
  )
  assert.ok(shared.includes("...harnessRuntimeOptions(input.harnessContext)"))
  assert.ok(shared.includes("input.remotePolicy"))
  assert.ok(
    shared.includes(
      "assertLocalThreadRunLease(options.threadId, input.runLease.owner, input.runLease.runId)"
    )
  )
})
