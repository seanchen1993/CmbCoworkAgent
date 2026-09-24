import { expect, it } from "vitest"
import { FunctionAgentInstances } from "./agent-instances"

const scope = { workspace: "project", threadId: "thread" }
const info = { id: "child", description: "Inspect files", type: "Explore" }
it("records real starts and terminal outcomes without granting execution authority", () => {
  const store = new FunctionAgentInstances()
  const finish = store.start(scope, info)
  expect(store.list(scope)).toEqual([{ ...info, status: "running" }])
  finish("completed")
  expect(store.list(scope)).toEqual([{ ...info, status: "completed" }])
  finish("failed")
  expect(store.list(scope)[0].status).toBe("completed")
})
it.each(["failed", "killed"] as const)("retains the actual %s terminal state", (status) => {
  const store = new FunctionAgentInstances()
  store.start(scope, info)(status)
  expect(store.list(scope)[0].status).toBe(status)
})
it("copies metadata and isolates workspace and thread", () => {
  const store = new FunctionAgentInstances()
  const source = { ...info, parentId: "parent", spawnedBy: "plugin" }
  store.start(scope, source)
  source.description = "changed"
  const result = store.list(scope)
  result[0].description = "mutated"
  expect(store.list(scope)[0]).toMatchObject({ ...info, parentId: "parent", spawnedBy: "plugin" })
  expect(store.list({ ...scope, workspace: "elsewhere" })).toEqual([])
  expect(store.list({ ...scope, threadId: "other" })).toEqual([])
})
it("does not let late completion overwrite a replacement id or revive cleared rows", () => {
  const store = new FunctionAgentInstances()
  const old = store.start(scope, info)
  const fresh = store.start(scope, { ...info, description: "replacement" })
  old("failed")
  expect(store.list(scope)[0]).toMatchObject({ description: "replacement", status: "running" })
  store.clear(scope.workspace, scope.threadId)
  fresh("completed")
  expect(store.list(scope)).toEqual([])
})
it("fails the list closed at its bound without failing native task start or settlement", () => {
  const store = new FunctionAgentInstances({ maxAgents: 2, maxScopes: 2 })
  store.start(scope, info)("completed")
  store.start(scope, { ...info, id: "second" })
  expect(() => store.start(scope, { ...info, id: "third" })("completed")).not.toThrow()
  expect(() => store.list(scope)).toThrow("MODS_AGENT_LIST_LIMIT")
  store.clear(scope.workspace, scope.threadId)
  store.start(scope, info)
  expect(store.list(scope)).toHaveLength(1)
})
it("clears only matching scopes and never reports unrecorded scopes as an empty list", () => {
  const store = new FunctionAgentInstances({ maxAgents: 2, maxScopes: 2 })
  store.start(scope, info)
  store.start({ ...scope, threadId: "second" }, info)
  store.start({ ...scope, threadId: "third" }, info)
  expect(() => store.list({ ...scope, threadId: "third" })).toThrow("MODS_AGENT_LIST_LIMIT")
  store.clear()
  expect(store.list(scope)).toEqual([])
  store.start(scope, info)
  store.start({ ...scope, workspace: "other" }, info)
  store.clear(scope.workspace)
  expect(store.list(scope)).toEqual([])
  expect(store.list({ ...scope, workspace: "other" })).toHaveLength(1)
})

it("does not retain oversized host metadata or fail its underlying task", () => {
  const store = new FunctionAgentInstances()
  expect(() =>
    store.start(scope, { ...info, description: "x".repeat(4001) })("completed")
  ).not.toThrow()
  expect(() => store.list(scope)).toThrow("MODS_AGENT_LIST_LIMIT")
  store.clear()
  expect(store.list(scope)).toEqual([])
})
