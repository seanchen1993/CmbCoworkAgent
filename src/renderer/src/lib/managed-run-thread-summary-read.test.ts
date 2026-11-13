import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import ts from "typescript"
import { expect, it, vi } from "vitest"

function actualReadBlock() {
  const path = fileURLToPath(new URL("../components/harness-board/HarnessBoardView.tsx", import.meta.url))
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let block: ts.IfStatement | undefined
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node) && node.expression.getText(source) === "existingThreadId" &&
      node.getText(source).includes("captureThreadSummaryRead")) block = node
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!block) throw Error("Actual managed-run summary reader missing")
  return ts.transpileModule(`async function invoke(){${block.getText(source)}}\ninvoke()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
}

it.each(["sync-throw", "async-reject", "success"] as const)(
  "closes the actual managed-run read publisher once after %s", async mode => {
    let done!: () => void
    const closed = new Promise<void>(resolve => { done = resolve })
    const publisher = { isCurrent: () => true, publish: vi.fn(), close: vi.fn(() => done()) }
    const failure = Error("controlled starter failure"), thread = { thread_id: "thread" }
    const get = vi.fn(() => {
      if (mode === "sync-throw") throw failure
      return mode === "async-reject" ? Promise.reject(failure) : Promise.resolve(thread)
    })
    const warn = vi.fn()
    const invoking = runInNewContext(actualReadBlock(), { existingThreadId: "thread",
      useAppStore: { getState: () => ({ captureThreadSummaryRead: () => publisher }) },
      window: { api: { threads: { get } } }, console: { warn } }) as Promise<void>
    await expect(invoking).resolves.toBeUndefined()
    await closed
    expect(get).toHaveBeenCalledWith("thread")
    expect(publisher.close).toHaveBeenCalledTimes(1)
    if (mode === "success") {
      expect(publisher.publish).toHaveBeenCalledWith(thread)
      expect(warn).not.toHaveBeenCalled()
    } else {
      expect(publisher.publish).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith("[ManagedRun] Failed to refresh session:", failure)
    }
  }
)
