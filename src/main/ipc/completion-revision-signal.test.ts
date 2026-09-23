import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"
import { expect, it } from "vitest"

/** Extract the production closures rather than reimplementing the IPC/IM routing in a fixture. */
function callbacks(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(resolve(path), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const values: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "runRevision") {
      expect(ts.isArrowFunction(node.initializer)).toBe(true)
      values.push(node.initializer.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return values
}
const desktop = callbacks("src/main/ipc/agent.ts")
const remote = callbacks("src/main/services/im/remote-runner.ts")
it("inventories every production desktop invoke/resume/interrupt and legacy IM revision closure", () => {
  expect(desktop).toHaveLength(3)
  expect(remote).toHaveLength(1)
})

it.each([
  ["desktop invoke", desktop[0]],
  ["desktop resume", desktop[1]],
  ["desktop interrupt", desktop[2]],
  ["legacy IM", remote[0]]
])(
  "forwards the completion deadline into %s streaming and preserves the original off signal",
  async (name, source) => {
    const user = new AbortController()
    const deadline = new AbortController()
    const configs: Array<{ signal: AbortSignal; configurable: object }> = []
    const consumedSignals: Array<AbortSignal | undefined> = []
    let waitForAbort = false
    const agent = {
      stream: async (_input: unknown, config: { signal: AbortSignal; configurable: object }) => {
        configs.push(config)
        return (async function* () {
          if (!waitForAbort) return
          await new Promise<never>((_resolve, reject) => {
            if (config.signal.aborted) reject(config.signal.reason)
            else
              config.signal.addEventListener("abort", () => reject(config.signal.reason), {
                once: true
              })
          })
          yield "unreachable"
        })()
      }
    }
    const consume = async (stream: AsyncIterable<unknown>, signal?: AbortSignal) => {
      consumedSignals.push(signal)
      for await (const _chunk of stream) void _chunk
    }
    const streamConfig = {
      signal: user.signal,
      configurable: { thread_id: "thread", existingLease: "keep-existing-run" },
      streamMode: ["messages", "values"],
      recursionLimit: 100
    }
    const context = {
      agent,
      resumeAgentRuntime: agent,
      intAgentRuntime: agent,
      abortController: user,
      signal: user.signal,
      streamConfig,
      resumeStreamConfig: streamConfig,
      interruptStreamConfig: streamConfig,
      consumeStreamWithSideEffects: consume,
      consumeResumeStream: consume,
      consumeInterruptStream: consume,
      streamConsumer: { consume },
      HumanMessage: class {
        constructor(readonly content: unknown) {}
      },
      userMessageId: "user-message",
      revision: 0,
      threadId: "thread",
      getAgentGraphRecursionLimit: () => 100
    }
    const code = ts.transpileModule(`const callback = ${source};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    }).outputText
    const callback = new Function(...Object.keys(context), `${code}\nreturn callback`)(
      ...Object.values(context)
    ) as (prompt: string, signal?: AbortSignal) => Promise<void>
    await callback("ordinary legacy repair")
    expect(configs[0].signal).toBe(user.signal)
    waitForAbort = true
    const pending = callback("budgeted repair", deadline.signal)
    void pending.catch(() => {})
    try {
      await expect.poll(() => configs.length).toBe(2)
      expect(configs[1].signal).toBe(deadline.signal)
      expect(configs[1].configurable).toMatchObject({ thread_id: "thread" })
      expect(streamConfig.signal).toBe(user.signal)
      expect(user.signal.aborted).toBe(false)
      if (name === "legacy IM") expect(consumedSignals.at(-1)).toBe(deadline.signal)
      deadline.abort(Error("MODS_COMPLETION_DEADLINE"))
      await expect(pending).rejects.toThrow("MODS_COMPLETION_DEADLINE")
    } finally {
      user.abort(Error("fixture cleanup"))
      deadline.abort(Error("fixture cleanup"))
      await pending.catch(() => {})
    }
  }
)
