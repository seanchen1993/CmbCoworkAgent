import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import ts from "typescript"
import { suppressCompositionPythonCache } from "./composition-python-cache"
import { isDerivedPlugin, setDerivationFamilies } from "../plugins/derivation-scope"

afterEach(() => setDerivationFamilies([]))

/** Call the public production sync entry through its real process runner and host derivation ledger. */
function syncEntry(deps: Record<string, unknown>) {
  const source = ts.createSourceFile(
    "service.ts",
    readFileSync(new URL("./service.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const node = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "syncHarnessProjectConstraints"
  )
  if (!node) throw Error("Missing production sync entry")
  const javascript = ts.transpileModule(node.getText(source).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(...Object.keys(deps), javascript + "\nreturn syncHarnessProjectConstraints")(
    ...Object.values(deps)
  ) as (id: string) => Promise<unknown>
}

/** Execute the production private runner with a controlled queue; avoid importing app singletons. */
function runner(deps: Record<string, unknown>) {
  deps = { suppressCompositionPythonCache, ...deps }
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
    configured: {
      readonlyPackage?: boolean
      cwd: string
      invocation: { executable: string; args: string[] }
    },
    log: { configKey: string } | undefined,
    timeout: number,
    signal: undefined,
    guard: () => Promise<void>
  ) => Promise<Buffer>
}

describe("native create verification at the process queue boundary", () => {
  it.each([true, false])(
    "public knowledge sync honors the original protected-source ledger (derived=%s)",
    async (derived) => {
      const root = mkdtempSync(join(tmpdir(), "sync-package-"))
      try {
        const board = join(root, "board_config.json")
        writeFileSync(board, '{"source":"retained"}')
        const release = vi.fn()
        const launch = vi.fn(spawn)
        const invoke = runner({
          harnessInvocationSemaphore: { acquire: async () => release },
          spawn: launch,
          HARNESS_ADAPTER_MAX_BUFFER: 1024 * 1024,
          formatAdapterError: (error: Error) => error.message,
          createHarnessInvocationError: (message: string) => Error(message),
          logHarnessInvocationFailure: () => {},
          logHarnessInvocationStart: () => {},
          logHarnessInvocationSuccess: () => {}
        })
        setDerivationFamilies([
          {
            familyId: "sync-family",
            originalId: "original",
            members: ["original", "derived"]
          }
        ])
        const sync = syncEntry({
          isDerivedPlugin,
          findCompatibleKnowledgePlugin: async () => ({
            plugin: { id: derived ? "derived" : "original", path: root },
            adapter: { id: "fixture", name: "Fixture" },
            config: {}
          }),
          readBoardConfigPlatformTextFromValue: () => "fixture sync",
          createKnowledgeCommandProject: () => ({}),
          parseInspectCommand: () => ({
            executable: "python",
            args: ["-c", 'import json; print(json.dumps({"ok":True,"message":"synced"}))']
          }),
          readLeanTokenStore: async () => ({ leanToken: "" }),
          runHarnessInvocationAsync: invoke,
          harnessCommandLogOptions: () => ({ configKey: "pull_knowledge" }),
          HARNESS_PULL_KNOWLEDGE_TIMEOUT_MS: 5000,
          decodeAdapterBuffer: (buffer: Buffer) => buffer.toString("utf8"),
          normalizeText: (value: unknown) => (typeof value === "string" ? value : ""),
          isObject: (value: unknown) => !!value && typeof value === "object"
        })
        if (derived) {
          await expect(sync("fixture")).rejects.toMatchObject({
            code: "HARNESS_KNOWLEDGE_SYNC_SOURCE_IMMUTABLE"
          })
          expect(launch).not.toHaveBeenCalled()
        } else {
          await expect(sync("fixture")).resolves.toMatchObject({ message: "synced" })
          expect(launch).toHaveBeenCalledOnce()
        }
        expect(readFileSync(board, "utf8")).toBe('{"source":"retained"}')
        expect(release).toHaveBeenCalledOnce()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it("rejects a protected package knowledge sync before it can start or mutate package bytes", async () => {
    const spawn = vi.fn(),
      release = vi.fn()
    const invoke = runner({
      harnessInvocationSemaphore: { acquire: async () => release },
      spawn,
      logHarnessInvocationFailure: () => {},
      formatAdapterError: (error: Error) => error.message
    })
    await expect(
      invoke(
        {
          readonlyPackage: true,
          cwd: "retained-source",
          invocation: {
            executable: "python",
            args: ["hooks/sync_agents.py", "--write-board-config"]
          }
        },
        { configKey: "pull_knowledge" },
        1000,
        undefined,
        async () => {}
      )
    ).rejects.toMatchObject({ code: "HARNESS_KNOWLEDGE_SYNC_SOURCE_IMMUTABLE" })
    expect(spawn).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

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

it("original internal Python imports preserve retained package bytes and entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "retained-python-"))
  try {
    writeFileSync(join(root, "fixture_module.py"), "VALUE = 42\n")
    const invoke = runner({
      harnessInvocationSemaphore: { acquire: async () => () => undefined },
      spawn,
      HARNESS_ADAPTER_MAX_BUFFER: 1024 * 1024,
      formatAdapterError: (error: Error) => error.message,
      createHarnessInvocationError: (message: string) => Error(message)
    })
    const configured = {
      cwd: root,
      invocation: {
        executable: "python",
        args: ["-c", "import fixture_module; print(fixture_module.VALUE)"]
      }
    }
    const protectedResult = await invoke(
      { ...configured, readonlyPackage: true },
      undefined,
      5000,
      undefined,
      async () => {}
    )
    expect(protectedResult.toString().trim()).toBe("42")
    expect(existsSync(join(root, "__pycache__"))).toBe(false)
    await invoke(configured, undefined, 5000, undefined, async () => {})
    expect(existsSync(join(root, "__pycache__"))).toBe(
      process.env.PYTHONDONTWRITEBYTECODE ? false : true
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it("public declared AutoBiz initialization also preserves package bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "public-composition-python-"))
  try {
    writeFileSync(
      join(root, "devclaw.stage-checks.json"),
      JSON.stringify({
        apiVersion: "devclaw.stage-check-adapter/v1",
        adapter: "autobiz-v1"
      })
    )
    writeFileSync(
      join(root, "devclaw.project-runtime.json"),
      JSON.stringify({
        apiVersion: "devclaw.project-runtime/v1",
        mode: "legacy",
        stateOwner: "plugin"
      })
    )
    writeFileSync(join(root, "fixture_module.py"), "VALUE = 42\n")
    const invoke = runner({
      harnessInvocationSemaphore: { acquire: async () => () => undefined },
      spawn,
      HARNESS_ADAPTER_MAX_BUFFER: 1024 * 1024,
      formatAdapterError: (error: Error) => error.message,
      createHarnessInvocationError: (message: string) => Error(message)
    })
    const result = await invoke(
      {
        cwd: root,
        invocation: {
          executable: "python",
          args: ["-c", "import fixture_module; print(fixture_module.VALUE)"]
        }
      },
      undefined,
      5000,
      undefined,
      async () => {}
    )
    expect(result.toString().trim()).toBe("42")
    expect(existsSync(join(root, "__pycache__"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
