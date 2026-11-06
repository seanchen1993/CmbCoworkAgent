import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../services/harness-stage-attribution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/harness-stage-attribution")>()),
  resolveHarnessExecutionStage: vi.fn(),
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../services/event-reporter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/event-reporter")>()),
  trackEvent: vi.fn()
}))

import {
  markHarnessStageAttributionDirty,
  resolveHarnessExecutionStage
} from "../services/harness-stage-attribution"
import { HarnessStageAttributionCache } from "../services/harness-stage-attribution-cache"
import { runHooks, type HookContext } from "../hooks/runner"
import type { HookConfig, HookEvent } from "../hooks/types"
import { LocalSandbox } from "./local-sandbox"
import { withWorkspaceExecution } from "./file-operation-lock"

const roots: string[] = []
const readEnv =
  "({name:process.env.HARNESS_NODE_NAME || null,status:process.env.HARNESS_NODE_STATUS || null})"
const stageLookup = vi.mocked(resolveHarnessExecutionStage)

function command(script: string): string {
  return `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(script).toString("base64")}','base64').toString('utf8'))"`
}

function hook(event: HookEvent, script: string, id: string = event): HookConfig {
  return {
    id,
    event,
    type: "command",
    enabled: true,
    command: command(script),
    createdAt: "",
    updatedAt: ""
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "harness-live-env-"))
  roots.push(root)
  const context: HookContext = {
    workspacePath: root,
    sessionId: "same-thread",
    toolName: "execute",
    harnessProjectId: "p",
    featureId: "f",
    harnessNodeName: "old",
    harnessNodeStatus: "old-status"
  }
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: context.sessionId,
    windowsSandbox: "none",
    harnessProjectId: context.harnessProjectId,
    featureId: context.featureId,
    harnessNodeName: context.harnessNodeName,
    harnessNodeStatus: context.harnessNodeStatus
  })
  return { root, context, sandbox }
}

beforeEach(() => {
  stageLookup.mockReset().mockResolvedValue(undefined)
  vi.mocked(markHarnessStageAttributionDirty).mockReset()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("Harness process environment", () => {
  it("updates both fields across nodes and status-only changes on one sandbox", async () => {
    const { sandbox } = await fixture()
    for (const stage of [
      { name: "Dev-编码", status: "进行中" },
      { name: "Test-测试", status: "进行中" },
      { name: "Test-测试", status: "已完成" },
      { name: "Ops-发布", status: null }
    ]) {
      stageLookup.mockResolvedValue({ nodeName: stage.name, nodeStatus: stage.status })
      const result = await sandbox.execute(command(`console.log(JSON.stringify(${readEnv}))`))
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.output.trim())).toEqual(stage)
    }
  })

  it("clears stale supplied and inherited values when a bound lookup fails", async () => {
    vi.stubEnv("HARNESS_NODE_NAME", "host-stage")
    vi.stubEnv("HARNESS_NODE_STATUS", "host-status")
    const { sandbox, root, context } = await fixture()
    const output = join(root, "hook.json")
    stageLookup.mockResolvedValue({ nodeName: null, nodeStatus: null })
    const result = await sandbox.execute(command(`console.log(JSON.stringify(${readEnv}))`))
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output.trim())).toEqual({ name: null, status: null })
    await runHooks(
      [
        hook(
          "Stop",
          `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({env:${readEnv},input:JSON.parse(require('fs').readFileSync(0,'utf8'))}))`
        )
      ],
      "Stop",
      context
    )
    const payload = JSON.parse(await readFile(output, "utf8"))
    expect(payload.env).toEqual({ name: null, status: null })
    expect(payload.input.harness_node_name).toBeUndefined()
    expect(payload.input.harness_node_status).toBeUndefined()
    expect(payload.input.feature_id).toBe("f")
    expect(context.harnessNodeName).toBe("old")
  })

  it("preserves explicit stage context for callers without a feature binding", async () => {
    const { root } = await fixture()
    const sandbox = new LocalSandbox({
      rootDir: root,
      windowsSandbox: "none",
      harnessNodeName: "explicit",
      harnessNodeStatus: "进行中"
    })
    const result = await sandbox.execute(command(`console.log(JSON.stringify(${readEnv}))`))
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output.trim())).toEqual({ name: "explicit", status: "进行中" })
    expect(stageLookup).toHaveBeenCalledWith(undefined, undefined)
  })

  it("refreshes each sequential hook, the command after PreToolUse, and PostToolUse", async () => {
    const { root, context } = await fixture()
    const state = join(root, "stage.json")
    const output = join(root, "hooks.jsonl")
    await writeFile(state, JSON.stringify({ name: "plan", status: "进行中" }))
    const cache = new HarnessStageAttributionCache({
      resolver: async () => JSON.parse(await readFile(state, "utf8")),
      now: () => 0
    })
    stageLookup.mockImplementation(async () => cache.getForExecution("p", "f"))
    vi.mocked(markHarnessStageAttributionDirty).mockImplementation(() => cache.markDirty("p", "f"))
    const record = `require('fs').appendFileSync(${JSON.stringify(output)},JSON.stringify({env:${readEnv},input:JSON.parse(require('fs').readFileSync(0,'utf8'))})+String.fromCharCode(10));`
    const changeStage = (name: string, status: string) =>
      `require('fs').writeFileSync(${JSON.stringify(state)},${JSON.stringify(JSON.stringify({ name, status }))});`
    const sandbox = new LocalSandbox({
      rootDir: root,
      windowsSandbox: "none",
      runId: context.sessionId,
      harnessProjectId: "p",
      featureId: "f",
      harnessNodeName: "old",
      harnessNodeStatus: "old-status",
      hooks: [
        hook("PreToolUse", record + changeStage("dev", "进行中"), "advance"),
        hook("PreToolUse", record, "observe"),
        hook("PostToolUse", record)
      ]
    })
    const result = await sandbox.execute(
      command(`console.log(JSON.stringify(${readEnv}));` + changeStage("dev", "已完成"))
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.output.trim())).toEqual({ name: "dev", status: "进行中" })
    const rows = (await readFile(output, "utf8"))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row))
    expect(rows.map((row) => row.env)).toEqual([
      { name: "plan", status: "进行中" },
      { name: "dev", status: "进行中" },
      { name: "dev", status: "已完成" }
    ])
    for (const row of rows) {
      expect(row.input.harness_node_name).toBe(row.env.name)
      expect(row.input.harness_node_status).toBe(row.env.status)
    }
  })

  it("reuses one inspection across read-only plugin hooks and Shell commands", async () => {
    const { root } = await fixture()
    const resolver = vi.fn(async () => ({ name: "dev", status: "进行中" }))
    const cache = new HarnessStageAttributionCache({ resolver, now: () => 0 })
    stageLookup.mockImplementation(async () => cache.getForExecution("p", "f"))
    vi.mocked(markHarnessStageAttributionDirty).mockImplementation(() => cache.markDirty("p", "f"))
    const sandbox = new LocalSandbox({
      rootDir: root,
      windowsSandbox: "none",
      harnessProjectId: "p",
      featureId: "f",
      hooks: ["PreToolUse", "PostToolUse"].map((event) => ({
        ...hook(event as HookEvent, ""),
        command: "echo ready",
        hookSourceType: "plugin" as const
      }))
    })
    for (let i = 0; i < 10; i++) {
      expect((await sandbox.execute("echo ready")).exitCode).toBe(0)
    }
    expect(stageLookup).toHaveBeenCalledTimes(30)
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(markHarnessStageAttributionDirty).not.toHaveBeenCalled()
  })

  it.each(["command", "hook"])(
    "resolves a queued %s only after workspace admission",
    async (kind) => {
      const { root, context, sandbox } = await fixture()
      const output = join(root, "queued.json")
      const admitted = deferred<void>()
      const release = deferred<void>()
      const blocker = withWorkspaceExecution(root, "write", async () => {
        admitted.resolve()
        await release.promise
      })
      await admitted.promise
      stageLookup.mockResolvedValue({ nodeName: "before", nodeStatus: "进行中" })
      const pending =
        kind === "command"
          ? sandbox.execute(
              command(
                `require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(${readEnv}))`
              )
            )
          : runHooks(
              [
                hook(
                  "PreToolUse",
                  `require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(${readEnv}))`
                )
              ],
              "PreToolUse",
              context
            )
      try {
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(stageLookup).not.toHaveBeenCalled()
        stageLookup.mockResolvedValue({ nodeName: "after", nodeStatus: "已完成" })
      } finally {
        release.resolve()
        await blocker
        await pending
      }
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        name: "after",
        status: "已完成"
      })
    }
  )

  it("invalidates cached state before admitting a hook queued behind a raw command", async () => {
    const { root, context, sandbox } = await fixture()
    const state = join(root, "raw-stage.json")
    const entered = join(root, "entered")
    const release = join(root, "release")
    const output = join(root, "after-raw.json")
    await writeFile(state, JSON.stringify({ name: "before", status: "进行中" }))
    const cache = new HarnessStageAttributionCache({
      resolver: async () => JSON.parse(await readFile(state, "utf8")),
      now: () => 0
    })
    stageLookup.mockImplementation(async () => cache.getForExecution("p", "f"))
    vi.mocked(markHarnessStageAttributionDirty).mockImplementation(() => cache.markDirty("p", "f"))
    const running = sandbox.executeRaw(
      command(`const fs=require('fs');
        fs.writeFileSync(${JSON.stringify(entered)},'ready');
        const timer=setInterval(()=>{
          if(!fs.existsSync(${JSON.stringify(release)})) return;
          clearInterval(timer);
          fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({name:'after',status:'已完成'}));
        },10);`)
    )
    try {
      await vi.waitFor(async () => expect(await readFile(entered, "utf8")).toBe("ready"))
      const pending = runHooks(
        [
          hook(
            "PreToolUse",
            `require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(${readEnv}))`
          )
        ],
        "PreToolUse",
        context
      )
      await writeFile(release, "go")
      await running
      await pending
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        name: "after",
        status: "已完成"
      })
    } finally {
      await writeFile(release, "go")
      await running
    }
  })

  it("keeps simultaneous background command environments independent", async () => {
    const { sandbox } = await fixture()
    const firstLookup = deferred<{ nodeName: string; nodeStatus: string }>()
    stageLookup
      .mockImplementationOnce(() => firstLookup.promise)
      .mockResolvedValue({ nodeName: "second", nodeStatus: "已完成" })
    const execute = () =>
      sandbox.executeRaw(
        command(`console.log(JSON.stringify(${readEnv}))`),
        "none",
        undefined,
        undefined,
        { background: true }
      )
    const first = execute()
    await vi.waitFor(() => expect(stageLookup).toHaveBeenCalledTimes(1))
    try {
      const second = await execute()
      expect(JSON.parse(second.output.trim())).toEqual({ name: "second", status: "已完成" })
    } finally {
      firstLookup.resolve({ nodeName: "first", nodeStatus: "进行中" })
    }
    expect(JSON.parse((await first).output.trim())).toEqual({ name: "first", status: "进行中" })
  })

  it("does not launch a command when cancelled during stage inspection", async () => {
    const { sandbox } = await fixture()
    const lookup = deferred<{ nodeName: string; nodeStatus: string }>()
    stageLookup.mockImplementationOnce(() => lookup.promise)
    const controller = new AbortController()
    const pending = sandbox.executeRaw(
      command("console.log('must not run')"),
      "none",
      undefined,
      controller.signal
    )
    await vi.waitFor(() => expect(stageLookup).toHaveBeenCalledTimes(1))
    controller.abort()
    try {
      const result = await pending
      expect(result.exitCode).toBe(130)
      expect(result.output).not.toContain("must not run")
    } finally {
      lookup.resolve({ nodeName: "too-late", nodeStatus: "进行中" })
    }
  })

  it("keeps async hooks nonblocking while resolving their execution-time snapshot", async () => {
    const { root, context } = await fixture()
    const output = join(root, "async.json")
    const lookup = deferred<{ nodeName: string; nodeStatus: string }>()
    stageLookup.mockImplementationOnce(() => lookup.promise)
    const onResult = vi.fn()
    const asyncHook = {
      ...hook(
        "PreToolUse",
        `require('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(${readEnv}))`
      ),
      async: true
    }
    try {
      await runHooks([asyncHook], "PreToolUse", context, onResult)
      expect(onResult).toHaveBeenCalledWith(
        "PreToolUse",
        asyncHook,
        expect.objectContaining({ asyncStatus: "pending" })
      )
      expect(markHarnessStageAttributionDirty).not.toHaveBeenCalled()
    } finally {
      lookup.resolve({ nodeName: "async-current", nodeStatus: "已完成" })
    }
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledWith(
        "PreToolUse",
        asyncHook,
        expect.objectContaining({ asyncStatus: "completed", exitCode: 0 })
      )
    )
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      name: "async-current",
      status: "已完成"
    })
    expect(context.harnessNodeName).toBe("old")
    expect(markHarnessStageAttributionDirty).toHaveBeenCalledExactlyOnceWith("p", "f")
  })

  it.skipIf(process.platform === "win32")(
    "checks read-only path restrictions against the refreshed env",
    async () => {
      const { sandbox } = await fixture()
      sandbox.setReadOnlyShellEnforced(true)
      stageLookup.mockResolvedValue({
        nodeName: "~/.ssh/nonexistent-test-key",
        nodeStatus: "进行中"
      })
      const result = await sandbox.execute('cat "$HARNESS_NODE_NAME"')
      expect(result.exitCode).toBe(1)
      expect(result.output).toContain("reading sensitive credential directories")
      expect(stageLookup).toHaveBeenCalled()
    }
  )
})
