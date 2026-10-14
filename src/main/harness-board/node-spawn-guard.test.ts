import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"
import ts from "typescript"

/** Execute the production private runner with a controlled queue; avoid importing app singletons. */
function runner(deps: Record<string, unknown>) {
  const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8")
  const start = source.indexOf("async function runHarnessInvocationAsync(")
  const end = source.indexOf("\nasync function runInspectAdapter(", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const javascript = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(
    "deps",
    `const {${Object.keys(deps).join(",")}} = deps;\n${javascript}\nreturn runHarnessInvocationAsync`
  )(deps) as (
    configured: { cwd: string; invocation: { executable: string; args: string[] } },
    log: undefined,
    timeout: number,
    signal: undefined,
    guard: () => Promise<void>
  ) => Promise<Buffer>
}

describe("native create verification at the process queue boundary", () => {
  it("waits for the semaphore then rejects changed identity before any process starts", async () => {
    let releaseQueue!: (release: () => void) => void
    let identity = "reviewed"
    const release = vi.fn()
    const spawn = vi.fn()
    const guard = vi.fn(async () => {
      if (identity !== "reviewed") throw Error("source changed while queued")
    })
    const invoke = runner({
      harnessInvocationSemaphore: {
        acquire: () =>
          new Promise((resolve) => {
            releaseQueue = resolve
          })
      },
      spawn,
      formatAdapterError: (error: Error) => error.message
    })
    const pending = invoke(
      { cwd: "fixture", invocation: { executable: "python", args: [] } },
      undefined,
      1000,
      undefined,
      guard
    )
    const rejected = expect(pending).rejects.toThrow("source changed while queued")
    expect(guard).not.toHaveBeenCalled()
    identity = "replaced"
    releaseQueue(release)
    await rejected
    expect(guard).toHaveBeenCalledTimes(1)
    expect(spawn).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })
})
