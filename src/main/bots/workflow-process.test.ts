import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { build } from "esbuild"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotWorkflowProcess, type BotWorkflowProcessPorts } from "./workflow-process"
import {
  createWorkflowRunStore,
  loadWorkflowRunForResumeAsync,
  sha256Hex
} from "../agent/workflow/run-store"
import { validateWorkflowScript } from "../agent/workflow/script"
import type { PersistedWorkflowRun } from "../agent/workflow/types"
import { workflowState, type WorkflowProcessInput } from "./workflow-contract"

let directory: string, entry: string
let executable = process.execPath
let runNumber = 0
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  await mkdir("output", { recursive: true })
  directory = await mkdtemp(resolve("output/bot-workflow-test-"))
  entry = join(directory, "workflow.cjs")
  const result = await build({
    entryPoints: ["src/main/bots/workflow-worker-entry.ts"],
    outfile: entry,
    platform: "node",
    format: "cjs",
    bundle: true,
    metafile: true,
    logLevel: "silent"
  })
  const imports = Object.keys(result.metafile!.inputs)
  expect(imports).toContain("src/main/agent/workflow/engine.ts")
  expect(imports).toContain("src/main/agent/workflow/sandbox.ts")
  expect(
    imports.some((name) => /src\/main\/(models\/|ipc\/|storage\.ts|agent\/runtime\.ts)/.test(name))
  ).toBe(false)
  if (process.env.CMB_BOT_WORKFLOW_BUILT_TEST === "1") {
    entry = resolve("out/main/bot-workflow.js")
    executable = (await import("electron")).default as unknown as string
  }
  vi.stubEnv("CMB_COWORK_AGENT_HOME", join(directory, "store"))
}, 20_000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
afterAll(async () => {
  vi.unstubAllEnvs()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function fixture(body: string, prior?: PersistedWorkflowRun) {
  const source =
    'export const meta = { name: "test", description: "workflow verification", phases: [{ title: "检查" }] };\n' +
    body
  const parsed = validateWorkflowScript(source)
  const now = new Date().toISOString()
  const state: PersistedWorkflowRun = prior ?? {
    version: 1,
    runId: `wf_test00${++runNumber}`,
    threadId: `thread_${runNumber}`,
    workflowName: parsed.meta.name,
    script: source,
    scriptSha256: sha256Hex(source),
    status: "running",
    phases: [],
    currentPhase: null,
    agents: [],
    logs: [],
    journal: [],
    stats: { agentsTotal: 0, agentsCached: 0, agentsFailed: 0, outputTokens: 0, durationMs: 0 },
    startedAt: now,
    updatedAt: now
  }
  const workspace = join(directory, "workspace")
  await mkdir(workspace, { recursive: true })
  const store = createWorkflowRunStore({
    workspacePath: workspace,
    threadId: state.threadId,
    initial: state
  })
  expect(await store.whenInitialPersisted).toBe(true)
  const abort = new AbortController()
  const calls: string[] = []
  const deny = async () => {
    throw new Error("未授权的文件访问")
  }
  const ports: BotWorkflowProcessPorts = {
    store,
    files: { read: deny, exists: deny, glob: deny, write: deny, workflow: deny },
    agent: async (request) => {
      calls.push(request.prompt)
      return { text: request.prompt, structured: undefined, outputTokens: 2 }
    },
    progress: () => {},
    check: () => {
      abort.signal.throwIfAborted()
    },
    isAwaitingApproval: () => false
  }
  const input: WorkflowProcessInput = {
    state: workflowState.parse(state),
    maxConcurrency: 2,
    defaultModelId: "configured-test-model",
    agentProfiles: []
  }
  const execute = (process = new BotWorkflowProcess({ entry, executable })) =>
    process.execute(input, ports, abort.signal)
  cleanups.push(async () => {
    abort.abort()
    await store.flush()
  })
  return { input, ports, execute, abort, calls, store, workspace }
}

it("reuses real parallel/pipeline dispatch and durable content-based replay across process restarts", async () => {
  const body = `const first = await parallel([() => agent("a"), () => agent("b")]);
    return await pipeline(first, item => agent("follow:" + item));`
  const test = await fixture(body)
  let active = 0,
    maximum = 0
  test.ports.agent = async (request) => {
    maximum = Math.max(maximum, ++active)
    test.calls.push(request.prompt)
    try {
      await delay(30, undefined, { signal: request.signal })
    } finally {
      active--
    }
    return { text: request.prompt, structured: undefined, outputTokens: 2 }
  }
  const result = await test.execute()
  expect(result.status).toBe("completed")
  expect(result.result).toEqual(["follow:a", "follow:b"])
  expect(maximum).toBe(2)
  expect(test.calls).toHaveLength(4)
  const recovered = await loadWorkflowRunForResumeAsync(
    test.workspace,
    test.input.state.threadId,
    test.input.state.runId
  )
  expect(recovered?.journal).toHaveLength(4)
  expect(recovered?.agents.every((agent) => agent.status === "completed")).toBe(true)
  const replay = await fixture(body, { ...recovered!, status: "running", resumed: true })
  const replayed = await replay.execute()
  expect(replayed.result).toEqual(result.result)
  expect(replayed.stats.agentsCached).toBe(4)
  expect(replay.calls).toHaveLength(0)
}, 15_000)

it("recovers a completed child after lost journal acknowledgement without reusing its identical sibling", async () => {
  const body = 'return await parallel([() => agent("same"), () => agent("same")]);'
  const first = await fixture(body)
  const receipts = new Map<string, { text: string; structured: undefined; outputTokens: number }>()
  const created: string[] = []
  const runner: BotWorkflowProcessPorts["agent"] = async (request) => {
    const key = request.durableCallKey!
    const previous = receipts.get(key)
    if (previous) return previous
    created.push(key)
    if (key.endsWith("_n0")) await delay(80)
    const result = { text: key, structured: undefined, outputTokens: 2 }
    receipts.set(key, result)
    return result
  }
  first.ports.agent = runner
  const append = first.store.appendJournal.bind(first.store)
  first.store.appendJournal = (entry) => {
    if (entry.durableCallKey?.endsWith("_n0")) throw new Error("injected lost acknowledgement")
    append(entry)
  }
  await expect(first.execute()).rejects.toThrow("injected lost acknowledgement")
  expect(receipts.size).toBe(2)
  expect(first.store.state.journal).toHaveLength(1)
  expect(first.store.state.journal[0].durableCallKey).toMatch(/_n1$/)
  const next = await fixture(body, {
    ...workflowState.strip().parse(first.store.state),
    resumed: true,
    status: "running"
  })
  next.ports.agent = runner
  const result = await next.execute()
  expect(result.status).toBe("completed")
  expect(new Set(result.result as string[])).toEqual(new Set(receipts.keys()))
  expect(created).toHaveLength(2)
  expect(next.store.state.journal).toHaveLength(2)
  const last = await fixture(body, {
    ...workflowState.strip().parse(next.store.state),
    resumed: true,
    status: "running"
  })
  last.ports.agent = runner
  expect((await last.execute()).stats.agentsCached).toBe(2)
  expect(created).toHaveLength(2)
}, 15_000)

it("routes all file primitives and nested scripts through the Host instead of touching a worker path", async () => {
  const test = await fixture(`const paths = await glob("*.txt");
    const value = await readFile(paths[0]);
    if (await exists(paths[0])) await writeFile("out.txt", value + " changed");
    return await workflow({ scriptPath: "child.js" }, { text: value });`)
  const calls: string[] = []
  test.ports.files = {
    glob: async (path) => {
      calls.push("glob:" + path)
      return ["in.txt"]
    },
    read: async (path) => {
      calls.push("read:" + path)
      return "source"
    },
    exists: async (path) => {
      calls.push("exists:" + path)
      return true
    },
    write: async (path, value, signal) => {
      signal.throwIfAborted()
      calls.push(`write:${path}:${value}`)
    },
    workflow: async (path) => {
      calls.push("workflow:" + path)
      return 'export const meta={name:"child",description:"child"}; return await agent(args.text);'
    }
  }
  const result = await test.execute()
  expect(result.status).toBe("completed")
  expect(result.result).toBe("source")
  expect(calls).toEqual([
    "glob:*.txt",
    "read:in.txt",
    "exists:in.txt",
    "write:out.txt:source changed",
    "workflow:child.js"
  ])
  expect(test.store.state.phases).toContain("检查")
}, 10_000)

it.each(["await Promise.resolve(); while (true) {}", "while (true) await null"])(
  "kills a post-await CPU/microtask loop without blocking the Host: %s",
  async (body) => {
    const test = await fixture(body)
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    try {
      await expect(
        test.execute(new BotWorkflowProcess({ entry, executable }, 300))
      ).rejects.toThrow("无响应")
      expect(ticks).toBeGreaterThan(10)
      // No frozen isolate is retained; a later workflow uses the same real entry.
      const next = await fixture('return await agent("alive");')
      expect((await next.execute()).result).toBe("alive")
    } finally {
      clearInterval(timer)
    }
  },
  10_000
)

it("cancels in-flight Host children and waits for their settlement before resolving cancellation", async () => {
  const test = await fixture('return await agent("wait");')
  let settled = false
  const launched = Promise.withResolvers<void>()
  test.ports.agent = async ({ signal }) => {
    launched.resolve()
    try {
      await delay(30_000, undefined, { signal })
    } finally {
      await delay(60)
      settled = true
    }
    return { text: "unexpected", structured: undefined, outputTokens: 0 }
  }
  const running = test.execute()
  const failure = expect(running).rejects.toThrow("user cancelled")
  await launched.promise
  test.abort.abort(new Error("user cancelled"))
  await failure
  expect(settled).toBe(true)
  expect(test.store.state.journal).toHaveLength(0)
}, 10_000)

it("rejects persistence failure and source/lease revocation rather than reporting completion", async () => {
  const test = await fixture('return await agent("work");')
  test.ports.store = { ...test.store, flush: async () => false }
  await expect(test.execute()).rejects.toThrow("未持久保存")
  const revoked = await fixture('return await agent("hold");')
  let authorized = true
  revoked.ports.check = () => {
    if (!authorized) throw new Error("lease revoked")
  }
  revoked.ports.agent = async ({ signal }) => {
    authorized = false
    await delay(30_000, undefined, { signal })
    return { text: "unexpected", structured: undefined, outputTokens: 0 }
  }
  await expect(revoked.execute(new BotWorkflowProcess({ entry, executable }, 300))).rejects.toThrow(
    "lease revoked"
  )
  expect(revoked.store.state.journal).toHaveLength(0)
}, 10_000)

it("does not expose Host variables, Node globals, or a constructor-chain escape to scripts", async () => {
  vi.stubEnv("CMB_WORKFLOW_PRIVATE_TEST", "must-not-enter-worker")
  const test = await fixture(`let escaped = false;
    try { (await agent("input")).constructor.constructor("return process")(); escaped = true; } catch {}
    return { escaped, node: typeof process, require: typeof require };`)
  const result = await test.execute()
  expect(result.result).toEqual({ escaped: false, node: "undefined", require: "undefined" })
}, 10_000)

it("rejects invalid wire data from a launched process without dispatching Host operations", async () => {
  const invalid = join(directory, "invalid.cjs")
  await writeFile(
    invalid,
    'process.on("message", () => process.send(JSON.stringify({kind:"call",id:1,request:{op:"execute",command:"bad"}})))'
  )
  const test = await fixture('return "no";')
  await expect(test.execute(new BotWorkflowProcess({ entry: invalid }))).rejects.toThrow()
  expect(test.calls).toEqual([])
})

it("limits actual Host agent calls across multiple simultaneous workflow processes", async () => {
  const a = await fixture('return await parallel([0,1,2,3,4,5].map(i => () => agent("a" + i)));')
  const b = await fixture('return await parallel([0,1,2,3,4,5].map(i => () => agent("b" + i)));')
  a.input.maxConcurrency = 6
  b.input.maxConcurrency = 6
  let active = 0,
    maximum = 0
  const agent: BotWorkflowProcessPorts["agent"] = async (request) => {
    maximum = Math.max(maximum, ++active)
    try {
      await delay(80, undefined, { signal: request.signal })
    } finally {
      active--
    }
    return { text: request.prompt, structured: undefined, outputTokens: 1 }
  }
  a.ports.agent = b.ports.agent = agent
  const process = new BotWorkflowProcess({ entry, executable })
  const results = await Promise.all([a.execute(process), b.execute(process)])
  expect(results.every((result) => result.status === "completed")).toBe(true)
  expect(maximum).toBe(4)
  expect(active).toBe(0)
}, 15_000)

it("gives file effects stable identities independent of parallel agent reply order", async () => {
  const body = `await parallel([() => agent("a"), () => agent("b")]);
    await writeFile("same.txt", "content"); await writeFile("same.txt", "content"); return "done";`
  const first = await fixture(body),
    second = await fixture(body)
  const ids: string[][] = [[], []]
  for (const [index, test] of [first, second].entries()) {
    test.ports.files.write = async (_path, _content, _signal, invocation) => {
      ids[index].push(invocation)
    }
    test.ports.agent = async (request) => {
      await delay(request.prompt === (index === 0 ? "a" : "b") ? 30 : 1)
      return { text: request.prompt, structured: undefined, outputTokens: 1 }
    }
    expect((await test.execute()).status).toBe("completed")
  }
  expect(ids[0]).toEqual(ids[1])
  expect(ids[0][0]).not.toBe(ids[0][1])
}, 10_000)

it("terminates a CPU-bound isolate when its owning Host process is killed", async () => {
  const { spawn } = await import("node:child_process")
  const test = await fixture("await Promise.resolve(); while (true) {}")
  const driver = join(directory, "host-driver.cjs")
  await writeFile(
    driver,
    `const { spawn } = require("node:child_process");
    const child = spawn(${JSON.stringify(executable)}, [${JSON.stringify(entry)}], {stdio:["ignore","ignore","ignore","ipc"],env:{...process.env,ELECTRON_RUN_AS_NODE:"1"}});
    child.on("message", raw => {
      const message = JSON.parse(raw);
      if (message.kind === "progress" && message.value.kind === "started")
        process.stdout.write(String(child.pid) + "\\n");
    });
    child.on("spawn", () => child.send(${JSON.stringify(JSON.stringify({ kind: "start", value: test.input }))}));`
  )
  const owner = spawn(process.execPath, [driver], { stdio: ["ignore", "pipe", "ignore"] })
  let pid = 0
  try {
    pid = await new Promise<number>((resolvePid, reject) => {
      const timeout = setTimeout(() => reject(new Error("Host fixture did not start")), 5000)
      owner.stdout.once("data", (data) => {
        clearTimeout(timeout)
        resolvePid(Number(String(data).trim()))
      })
      owner.once("error", reject)
    })
    expect(pid).toBeGreaterThan(0)
    await delay(100)
    owner.kill("SIGKILL")
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        },
        { timeout: 5000 }
      )
      .toBe(true)
  } finally {
    owner.kill("SIGKILL")
    if (pid) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        /* already terminated */
      }
    }
  }
}, 12_000)

it("bounds background workflow processes, cancels queued work and shares agent admission with foreground workflows", async () => {
  const tests = await Promise.all(
    Array.from({ length: 6 }, () => fixture('return await agent("held");'))
  )
  const process = new BotWorkflowProcess({ entry, executable })
  let active = 0,
    maximum = 0,
    started = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  cleanups.push(async () => {
    release()
  })
  for (const test of tests)
    test.ports.agent = async ({ signal }) => {
      maximum = Math.max(maximum, ++active)
      started++
      try {
        await held
        signal.throwIfAborted()
        return { text: "done", structured: undefined, outputTokens: 1 }
      } finally {
        active--
      }
    }
  const first = tests
    .slice(0, 4)
    .map((test) => process.execute(test.input, test.ports, test.abort.signal, true))
  const queued = process.execute(tests[4].input, tests[4].ports, tests[4].abort.signal, true)
  const rejected = expect(queued).rejects.toThrow("queue cancelled")
  const foreground = tests[5].execute(process)
  expect(process.isActive(tests[0].input.state.threadId)).toBe(true)
  expect(process.isActive(tests[0].input.state.threadId, false)).toBe(false)
  expect(process.isActive(tests[5].input.state.threadId, false)).toBe(true)
  tests[4].abort.abort(new Error("queue cancelled"))
  await rejected
  for (let i = 0; i < 150 && started < 4; i++) await delay(20)
  expect(started).toBe(4)
  expect(maximum).toBe(4)
  release()
  const results = await Promise.all([...first, foreground])
  expect(results.every((result) => result.status === "completed")).toBe(true)
  expect(started).toBe(5)
  expect(active).toBe(0)
  expect(process.isActive(tests[4].input.state.threadId)).toBe(false)
}, 15000)
