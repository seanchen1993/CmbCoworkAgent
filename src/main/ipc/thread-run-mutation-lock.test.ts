import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"

const dbState = vi.hoisted(() => ({
  row: null as { thread_id: string; created_at: number; metadata: string | null } | null
}))

vi.mock("../db", () => ({
  getThreadCore: () => dbState.row
}))

import {
  requireThreadMutationLease,
  withThreadMutationLeaseLock,
  withThreadRunMutationLock
} from "./thread-run-mutation-lock"

describe("thread mutation incarnation lease", () => {
  it("rejects a queued old request after a same-ms same-id replacement", async () => {
    dbState.row = {
      thread_id: "fixed-id",
      created_at: 123,
      metadata: JSON.stringify({ cmb_thread_incarnation: "old-token" })
    }
    const lease = requireThreadMutationLease("fixed-id")

    let acquired!: () => void
    let release!: () => void
    const acquiredPromise = new Promise<void>((resolve) => {
      acquired = resolve
    })
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = withThreadRunMutationLock("fixed-id", async () => {
      acquired()
      await releasePromise
    })
    await acquiredPromise

    let committed = false
    const queued = withThreadMutationLeaseLock(lease, () => {
      committed = true
    })
    dbState.row = {
      thread_id: "fixed-id",
      created_at: 123,
      metadata: JSON.stringify({ cmb_thread_incarnation: "replacement-token" })
    }
    release()
    await holder

    await expect(queued).rejects.toThrow(/Thread changed while the request was queued/)
    expect(committed).toBe(false)
  })

  it("routes every source-sensitive queued thread operation through the lease helper", () => {
    const source = ts.createSourceFile(
      "threads.ts",
      readFileSync(new URL("./threads.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true
    )
    const operations = new Map<string, ts.FunctionLikeDeclaration>()
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name) operations.set(node.name.text, node)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "ipcMain" &&
        node.expression.name.text === "handle"
      ) {
        const [name, handler] = node.arguments
        if (ts.isStringLiteral(name) && ts.isArrowFunction(handler)) {
          operations.set(name.text, handler)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)

    for (const [name, capture] of [
      ["forkThread", "requireThreadMutationLease"],
      ["listForkableCheckpoints", "requireThreadMutationLease"],
      ["resolveForkCheckpointForMessage", "requireThreadMutationLease"],
      ["threads:appendMessages", "captureThreadMutationLease"],
      ["threads:replaceMessageId", "requireThreadMutationLease"],
      ["threads:update", "requireThreadMutationLease"],
      ["threads:mergeThreadValues", "requireThreadMutationLease"],
      ["threads:persistSubagentTranscripts", "requireThreadMutationLease"]
    ]) {
      const body = operations.get(name)?.body
      expect(body, name).toBeDefined()
      const leases: ts.VariableDeclaration[] = []
      const lockCalls: ts.CallExpression[] = []
      const collect = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          node.initializer && ts.isCallExpression(node.initializer) &&
          node.initializer.expression.getText(source) === capture
        ) leases.push(node)
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === "withThreadMutationLeaseLock"
        ) lockCalls.push(node)
        ts.forEachChild(node, collect)
      }
      collect(body!)
      expect(leases, name).toHaveLength(1)
      const [lease] = leases
      expect(lockCalls, name).toHaveLength(1)
      expect(lockCalls[0].arguments[0].getText(source), name).toBe(lease.name.getText(source))
      expect(lockCalls[0].getStart(source), name).toBeGreaterThan(lease.getStart(source))
    }
  })

  it("marks interrupted forks after committing buffered output and before releasing the run", () => {
    const agent = readFileSync(fileURLToPath(new URL("./agent.ts", import.meta.url)), "utf8")
    const start = agent.indexOf("async function settlePhysicalAgentRun({")
    const settlement = agent.slice(start, start + 8_000)
    const flush = settlement.indexOf('name: "flush-stream-transcript"')
    const mark = settlement.indexOf('name: "persist-interrupted-fork-boundary"')
    const release = settlement.indexOf('name: "release-active-controller"')
    expect(flush).toBeGreaterThanOrEqual(0)
    expect(mark).toBeGreaterThan(flush)
    expect(release).toBeGreaterThan(mark)
    expect(settlement.slice(mark, release)).toContain('source: "agent_run_interrupted"')
    const source = ts.createSourceFile("agent.ts", agent, ts.ScriptTarget.Latest, true)
    const covered = new Set<string>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
        node.expression.text === "settlePhysicalAgentRun") {
        const input = node.arguments[0]
        if (input && ts.isObjectLiteralExpression(input) && input.properties.some((property) =>
          ts.isShorthandPropertyAssignment(property) && property.name.text === "interruptedForkBoundary"
        )) {
          for (const property of input.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(source) === "kind" &&
              ts.isStringLiteral(property.initializer)) covered.add(property.initializer.text)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect([...covered].sort()).toEqual(["interrupt", "invoke", "resume"])
  })
})
