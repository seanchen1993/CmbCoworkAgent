import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
  isModObject,
  type FunctionHostCall,
  type FunctionHostReply,
  type FunctionInvocation
} from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { validateFunctionTree } from "../../../shared/mods/v2/ui"
import {
  compileFunctionPlugin,
  projectFunctionComponents,
  type CompiledFunctionPlugin
} from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ProjectFunctionFiles } from "./file-access"
import { validateRegisteredToolInput } from "./tool-schema"

const NAME = "AutobizDevOps_Plugin_Kanban_Fullstack0920_Mods"
const guests: FunctionGuestRuntime[] = []
let fixtureRoot: string
let pluginRoot: string
let workspace: string
let compiled: CompiledFunctionPlugin
const fileSource = "def first(items):\n    return items[0].name\n"

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "mods-autobiz-fullstack-"))
  pluginRoot = join(fixtureRoot, "plugin")
  workspace = join(fixtureRoot, "project")
  await cp(resolve("examples/autobiz-fullstack-mods"), pluginRoot, { recursive: true })
  await writeFile(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({ name: NAME, version: "1.0.87", mods: "mods/manifest.json" })
  )
  await mkdir(join(workspace, "src"), { recursive: true })
  await writeFile(join(workspace, "src/example.py"), fileSource)
  compiled = await compileFunctionPlugin(pluginRoot)
})

afterEach(() => {
  for (const guest of guests.splice(0)) guest.dispose()
})

afterAll(async () => {
  if (!fixtureRoot) return
  const target = resolve(fixtureRoot)
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith("mods-autobiz-fullstack-")
  )
    throw Error("Unexpected fullstack fixture cleanup path")
  await rm(target, { recursive: true, force: true })
})

function deferred<T>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolveValue) => {
    release = resolveValue
  })
  return { promise, release }
}

function row(feature = "checkout", updates: ModObject = {}): ModObject {
  // A finite wire fixture, not execution of the upstream Python normalizer or validator.
  return {
    feature,
    checkpoint: "specs_in_progress",
    stage: "需求规格",
    workflowTemplate: "lean",
    workflowNodes: ["specs", "implementation", "review"],
    workflowDecisions: {},
    owner: "fixture",
    updated_at: "before",
    ...updates
  }
}

function stateResult(records: ModObject = { checkout: row() }, updates: ModObject = {}): ModObject {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: "autobizdevops.state.read.v1",
      workspace,
      stateJsonPath: join(workspace, ".autobizdevops/state.json"),
      source: "state.json",
      exists: true,
      ok: true,
      errors: [],
      recordErrors: {},
      records,
      ...updates
    }),
    stderr: ""
  }
}

function metadata(event: string, extra: Partial<FunctionInvocation> = {}): FunctionInvocation {
  return {
    event,
    origin: { plugin: "engine", tier: "core" },
    plugin: { name: NAME, root: pluginRoot },
    modelProtocol: compiled.modelProtocol,
    capabilities: [
      "command.register",
      "session.root",
      "process.run",
      "fs.read",
      "model.complete",
      "ui.open",
      "ui.resolve",
      "ui.invalidate"
    ],
    ...extra
  }
}

async function guest(ids: string[]) {
  const projection = projectFunctionComponents(compiled, { mode: "selected", ids, config: {} })
  const runtime = await FunctionGuestRuntime.create(projection.code, projection.options)
  guests.push(runtime)
  return { runtime, projection }
}

function host(
  options: {
    root?: string
    state?: () => ModObject | Promise<ModObject>
    read?: (path: string, signal: AbortSignal) => Promise<ModJson>
    model?: () => ModJson | Promise<ModJson>
  } = {}
) {
  const calls: { method: string; args: ModJson }[] = []
  const files = new ProjectFunctionFiles(
    workspace,
    () => undefined,
    async (value) => value
  )
  const call: FunctionHostCall = async (method, args, signal): Promise<FunctionHostReply> => {
    calls.push({ method, args: structuredClone(args) })
    if (method === "next") return { value: {} }
    if (!Array.isArray(args)) throw Error("Expected SDK positional arguments")
    if (method === "command.register") {
      if (!isModObject(args[0]) || typeof args[0].name !== "string") throw Error("Command shape")
      return { value: { command: args[0].name } }
    }
    if (method === "session.root") return { value: options.root ?? workspace }
    if (method === "process.run") return { value: await (options.state?.() ?? stateResult()) }
    if (method === "fs.read") {
      if (typeof args[0] !== "string") throw Error("File path shape")
      return {
        value: options.read
          ? await options.read(args[0], signal)
          : await files.run("fs.read", args[0], signal)
      }
    }
    if (method === "model.complete") return { value: await (options.model?.() ?? "有限单文件意见") }
    if (method === "ui.open" || method === "ui.invalidate") return {}
    throw Error(`Unexpected SDK call: ${method}`)
  }
  return { call, calls, methods: () => calls.map((entry) => entry.method) }
}

async function run(
  runtime: FunctionGuestRuntime,
  command: string,
  args: string,
  call: FunctionHostCall
) {
  const event = { command, args }
  for (const registration of runtime.registrations) {
    if (registration.pattern === "command.run" && (await runtime.matches(registration.id, event)))
      return runtime.invoke(registration.id, event, call, metadata("command.run"))
  }
  throw Error(`Command was not projected: ${command}`)
}

async function registerCommands(runtime: FunctionGuestRuntime) {
  const observed = host()
  for (const registration of runtime.registrations.filter(
    (entry) => entry.pattern === "session.start"
  ))
    await runtime.invoke(registration.id, {}, observed.call, metadata("session.start"))
  return observed.calls
    .filter((entry) => entry.method === "command.register")
    .map((entry) => {
      if (!Array.isArray(entry.args) || !isModObject(entry.args[0])) throw Error("Command shape")
      return entry.args[0]
    })
}

function output(value: ModJson | undefined): ModObject {
  if (!isModObject(value)) throw Error("Expected structured command result")
  return value
}

async function render(runtime: FunctionGuestRuntime, call: FunctionHostCall) {
  const registration = runtime.registrations.find((entry) => entry.pattern === "ui.render")
  if (!registration) throw Error("Board was not projected")
  const result = await runtime.invoke(
    registration.id,
    { surface: "desktop", component: "Pane", requestId: "autobiz-fullstack-board", props: {} },
    call,
    metadata("ui.render", { uiGeneration: "fullstack-board" })
  )
  validateFunctionTree(result.value)
  return result.value
}

function uiElement(tree: ModJson | undefined, key: string): ModObject {
  if (isModObject(tree)) {
    if (isModObject(tree.props) && tree.props.key === key) return tree
    if (Array.isArray(tree.children)) {
      for (const child of tree.children) {
        try {
          return uiElement(child, key)
        } catch {
          // Search the other finite children; this helper never invokes a UI action.
        }
      }
    }
  }
  throw Error(`Missing UI element: ${key}`)
}

async function callback(
  runtime: FunctionGuestRuntime,
  tree: ModJson | undefined,
  key: string,
  kind: "onPress" | "onSelect",
  call: FunctionHostCall,
  value?: string
) {
  const element = uiElement(tree, key)
  if (!isModObject(element.press) || typeof element.press.handle !== "number")
    throw Error("Missing native callback handle")
  return runtime.invoke(
    "callback",
    {
      surface: "desktop",
      component: "Pane",
      requestId: "autobiz-fullstack-board",
      plugin: NAME,
      element: key,
      ...(value === undefined ? {} : { value })
    },
    call,
    metadata(kind === "onPress" ? "ui.press" : "ui.select", {
      uiGeneration: "fullstack-board",
      callback: { handle: element.press.handle, generation: "fullstack-board", kind }
    })
  )
}

function actionArgs(input: ModObject): string {
  return JSON.stringify({
    version: 1,
    task: "检视真实文件",
    runId: "run",
    stepId: "prepare",
    executionId: "execution",
    config: {},
    input
  })
}

describe("fullstack 0920 native component overlay", () => {
  it("compiles four independent components and keeps status-only selection free of review/actions/gates", async () => {
    expect(compiled.name).toBe(NAME)
    expect(compiled.modelProtocol).toBe("legacy-v1")
    expect(compiled.components?.map((entry) => entry.id)).toEqual([
      "status",
      "board",
      "review",
      "review-input"
    ])
    const { runtime, projection } = await guest(["status"])
    expect(projection.actions).toEqual([])
    expect(runtime.registrations.map((entry) => entry.pattern)).not.toContain("completion.check")
    expect(runtime.registrations.map((entry) => entry.pattern)).not.toContain("ui.render")
    const commands = await registerCommands(runtime)
    expect(commands.map((entry) => entry.name)).toEqual([
      "autobiz-fullstack-info",
      "autobiz-fullstack-status"
    ])
    expect(commands[1]).not.toHaveProperty("immediate")
    expect(() =>
      projectFunctionComponents(compiled, { mode: "selected", ids: ["board"], config: {} })
    ).toThrow("CLAW_COMPONENT_DEPENDENCY_REQUIRED")
    const info = await run(runtime, "autobiz-fullstack-info", "", host().call)
    expect(output(info.value).text).toContain("dev_autobiz_fullstack_0920")
    expect(output(info.value).text).toContain("504e327d2f9a4d9e30e9f541c4432accf8000ad5")
    expect(output(info.value).text).toContain("1.0.87")
    expect(output(info.value).text).toContain("不推进 checkpoint")
  })

  it("exports only the selected hidden awaitable prepare action with mandatory inputs and a closed output", async () => {
    const { runtime, projection } = await guest(["review-input"])
    const commands = await registerCommands(runtime)
    expect(commands).toEqual([
      {
        name: "autobiz-fullstack-prepare-review",
        description: "Autobiz：准备真实单文件检视输入",
        isHidden: true
      }
    ])
    expect(projection.actions.map((entry) => entry.id)).toEqual(["prepare-review"])
    const action = projection.actions[0]
    expect(action.name).toBe("Autobiz：准备真实单文件检视输入")
    expect(action.inputSchema.required).toEqual(["feature", "path"])
    expect(action.outputSchema?.additionalProperties).toBe(false)
    expect(Object.keys(action.outputSchema?.properties ?? {})).toEqual([
      "feature",
      "checkpoint",
      "stage",
      "path",
      "source",
      "context"
    ])
    expect(() =>
      validateRegisteredToolInput(action.inputSchema, { path: "src/example.py" })
    ).toThrow()
    expect(runtime.registrations.map((entry) => entry.pattern)).not.toContain("completion.check")
    await expect(
      run(runtime, "autobiz-fullstack-review", "src/example.py", host().call)
    ).rejects.toThrow("Command was not projected")
  })

  it("derives approved process arguments only from the current project and preserves normalized dynamic nodes", async () => {
    const { runtime } = await guest(["status"])
    const observed = host()
    const result = await run(runtime, "autobiz-fullstack-status", "checkout", observed.call)
    expect(observed.methods()).toEqual(["session.root", "process.run"])
    expect(observed.calls[1].args).toEqual([
      ["python", "-B", "-X", "utf8", pluginRoot + "/read_state_json.py"],
      {
        cwd: workspace,
        env: {
          PLUGIN_WORKSPACE: dirname(workspace).replace(/\\/g, "/"),
          PROJECT_DIR: basename(workspace),
          PYTHONIOENCODING: "utf-8",
          PYTHONDONTWRITEBYTECODE: "1"
        },
        timeoutMs: 30000
      }
    ])
    expect(output(result.value).text).toContain("specs_in_progress")
    expect(output(result.value).text).toContain("需求规格")
    expect(output(result.value).text).toContain("specs、implementation、review")
    expect(observed.methods()).not.toContain("fs.read")
  })

  it.each([
    "/",
    "C:\\",
    "C:relative",
    "relative/project",
    "\\\\server\\share",
    "/a/../b",
    "/parent/ project"
  ])(
    "rejects invalid or filesystem-root session location %s before starting a process",
    async (root) => {
      const { runtime } = await guest(["status"])
      const observed = host({ root })
      await expect(run(runtime, "autobiz-fullstack-status", "", observed.call)).rejects.toThrow()
      expect(observed.methods()).toEqual(["session.root"])
    }
  )

  it.each([
    { label: "process exit", result: () => ({ ...stateResult(), exitCode: 1 }) },
    { label: "schema", result: () => stateResult(undefined, { schemaVersion: "other" }) },
    { label: "ok false", result: () => stateResult(undefined, { ok: false }) },
    {
      label: "record error",
      result: () => stateResult(undefined, { recordErrors: { broken: ["invalid"] } })
    },
    {
      label: "outside workspace",
      result: () => stateResult(undefined, { workspace: "/other/project" })
    },
    { label: "record shape", result: () => stateResult({ checkout: row("different") }) }
  ])("rejects $label instead of presenting a successful empty project", async ({ result }) => {
    const { runtime } = await guest(["status"])
    const observed = host({ state: result })
    await expect(
      run(runtime, "autobiz-fullstack-status", "checkout", observed.call)
    ).rejects.toThrow()
    expect(observed.methods()).toEqual(["session.root", "process.run"])
  })

  it("rejects an unknown feature even when another real record exists; never picks the first", async () => {
    const { runtime } = await guest(["review-input"])
    const observed = host()
    await expect(
      run(
        runtime,
        "autobiz-fullstack-prepare-review",
        actionArgs({
          feature: "unknown",
          path: "src/example.py"
        }),
        observed.call
      )
    ).rejects.toThrow()
    expect(observed.methods()).toEqual(["session.root", "process.run"])
  })

  it("renders a real native Pane with explicit selection and refreshes through the approved process", async () => {
    const { runtime } = await guest(["status", "board"])
    let current = row()
    const observed = host({ state: () => stateResult({ checkout: current }) })
    const commands = await registerCommands(runtime)
    expect(commands.find((entry) => entry.name === "autobiz-fullstack-board")).not.toHaveProperty(
      "immediate"
    )
    await run(runtime, "autobiz-fullstack-board", "", observed.call)
    let tree = await render(runtime, observed.call)
    expect(uiElement(tree, "feature").props).toMatchObject({ value: "" })
    expect(JSON.stringify(tree)).toContain("尚未选定 Feature")
    await callback(runtime, tree, "feature", "onSelect", observed.call, "checkout")
    tree = await render(runtime, observed.call)
    expect(JSON.stringify(tree)).toContain("specs、implementation、review")
    current = row("checkout", {
      checkpoint: "review_in_progress",
      stage: "检视",
      workflowNodes: ["review", "delivery"]
    })
    const before = observed.methods().filter((method) => method === "process.run").length
    await callback(runtime, tree, "refresh", "onPress", observed.call)
    tree = await render(runtime, observed.call)
    expect(observed.methods().filter((method) => method === "process.run")).toHaveLength(before + 1)
    expect(JSON.stringify(tree)).toContain("review_in_progress")
    expect(JSON.stringify(tree)).toContain("review、delivery")
    expect(observed.methods()).not.toContain("fs.read")
    expect(observed.methods()).not.toContain("model.complete")
  })

  it("keeps all Feature records reachable within the native 200-option Select limit", async () => {
    const records: ModObject = {}
    for (let index = 0; index < 205; index++) {
      const feature = `feature-${String(index).padStart(3, "0")}`
      records[feature] = row(feature)
    }
    const { runtime } = await guest(["status", "board"])
    const observed = host({ state: () => stateResult(records) })
    await run(runtime, "autobiz-fullstack-board", "", observed.call)
    let tree = await render(runtime, observed.call)
    const first = output(uiElement(tree, "feature").props)
    expect(Array.isArray(first.options) && first.options.length <= 200).toBe(true)
    expect(JSON.stringify(first.options)).not.toContain("feature-204")
    await callback(runtime, tree, "next", "onPress", observed.call)
    tree = await render(runtime, observed.call)
    expect(JSON.stringify(uiElement(tree, "feature").props)).toContain("feature-204")
    await callback(runtime, tree, "feature", "onSelect", observed.call, "feature-204")
    tree = await render(runtime, observed.call)
    await callback(runtime, tree, "previous", "onPress", observed.call)
    tree = await render(runtime, observed.call)
    expect(output(uiElement(tree, "feature").props).value).toBe("feature-204")
    expect(observed.methods().filter((method) => method === "process.run")).toHaveLength(1)
  })

  it.each([
    "../outside.py",
    "/outside.py",
    "C:\\outside.py",
    "\\\\server\\share\\file.py",
    "src/../file.py",
    "src/file.py:stream",
    "src/NUL.py",
    "src/file.py.",
    ".autobizdevops/state.json",
    "STATE.md",
    "logs/hooks.ndjson",
    ".plan.lock"
  ])("rejects non-project or protected file path %s before a file/model call", async (path) => {
    const { runtime } = await guest(["review"])
    const observed = host()
    await expect(run(runtime, "autobiz-fullstack-review", path, observed.call)).rejects.toThrow()
    expect(observed.methods()).toEqual([])
  })

  it("reads a real project file and remains pending until the legacy-v1 default model replies", async () => {
    const { runtime } = await guest(["review"])
    const entered = deferred<void>()
    const gate = deferred<ModJson>()
    const observed = host({
      model: () => {
        entered.release()
        return gate.promise
      }
    })
    let settled = false
    const pending = run(
      runtime,
      "autobiz-fullstack-review",
      "src\\example.py",
      observed.call
    ).finally(() => {
      settled = true
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw Error("Returned before model")
        })
      ])
      expect(settled).toBe(false)
      expect(observed.methods()).toEqual(["fs.read", "model.complete"])
      expect(observed.calls[1].args).toMatchObject([
        {
          model: "default",
          maxTokens: 1600,
          prompt: `文件：src/example.py\n<source>\n${fileSource}\n</source>`
        }
      ])
    } finally {
      gate.release("真实等待后的有限意见")
      await Promise.allSettled([pending])
    }
    expect(output((await pending).value).text).toContain("真实等待后的有限意见")
    expect(output((await pending).value).text).toContain("未执行测试")
  })

  it.each(["", " ", "x".repeat(4001)])(
    "rejects empty or oversized file content before the model",
    async (source) => {
      const { runtime } = await guest(["review"])
      const observed = host({ read: async () => source })
      await expect(
        run(runtime, "autobiz-fullstack-review", "src/example.py", observed.call)
      ).rejects.toThrow()
      expect(observed.methods()).toEqual(["fs.read"])
    }
  )

  it.each(["", " ", "x".repeat(4001), { isAnswered: true, text: "wrong protocol" }])(
    "rejects an empty, oversized, or result-v1 reply instead of claiming a valid model review",
    async (reply) => {
      const { runtime } = await guest(["review"])
      const observed = host({ model: () => reply })
      await expect(
        run(runtime, "autobiz-fullstack-review", "src/example.py", observed.call)
      ).rejects.toThrow()
      expect(observed.methods()).toEqual(["fs.read", "model.complete"])
    }
  )

  it("propagates the host file boundary refusal without calling a model", async () => {
    const { runtime } = await guest(["review"])
    const observed = host({
      read: async () => {
        throw Error("MODS_FS_OUTSIDE_PROJECT")
      }
    })
    await expect(
      run(runtime, "autobiz-fullstack-review", "linked.py", observed.call)
    ).rejects.toThrow()
    expect(observed.methods()).toEqual(["fs.read"])
  })

  it("awaits a real file read, rechecks the selected normalized record, and returns exactly the declared object", async () => {
    const { runtime, projection } = await guest(["review-input"])
    const entered = deferred<void>()
    const gate = deferred<void>()
    const observed = host({
      read: async (path) => {
        entered.release()
        await gate.promise
        return readFile(join(workspace, path), "utf8")
      }
    })
    let settled = false
    const pending = run(
      runtime,
      "autobiz-fullstack-prepare-review",
      actionArgs({
        feature: "checkout",
        path: "src/example.py"
      }),
      observed.call
    ).finally(() => {
      settled = true
    })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw Error("Returned before file")
        })
      ])
      expect(settled).toBe(false)
      expect(observed.methods()).toEqual(["session.root", "process.run", "fs.read"])
    } finally {
      gate.release()
      await Promise.allSettled([pending])
    }
    const result = output((await pending).value)
    const prepared = output(result.output)
    expect(Object.keys(prepared)).toEqual([
      "feature",
      "checkpoint",
      "stage",
      "path",
      "source",
      "context"
    ])
    expect(prepared).toMatchObject({
      feature: "checkout",
      checkpoint: "specs_in_progress",
      stage: "需求规格",
      path: "src/example.py",
      source: fileSource
    })
    expect(prepared.context).toContain("dev_autobiz_fullstack_0920")
    expect(observed.methods()).toEqual([
      "session.root",
      "process.run",
      "fs.read",
      "session.root",
      "process.run"
    ])
    const schema = projection.actions[0].outputSchema
    if (!schema) throw Error("Missing closed output schema")
    expect(() => validateRegisteredToolInput(schema, prepared)).not.toThrow()
    expect(() =>
      validateRegisteredToolInput(schema, { ...prepared, review: "not permitted" })
    ).toThrow()
  })

  it("rejects any selected record change, including only updated_at, but permits unrelated Feature changes", async () => {
    const { runtime } = await guest(["review-input"])
    let reads = 0
    const changed = host({
      state: () =>
        stateResult({
          checkout: row("checkout", { updated_at: ++reads === 1 ? "before" : "after" })
        })
    })
    await expect(
      run(
        runtime,
        "autobiz-fullstack-prepare-review",
        actionArgs({ feature: "checkout", path: "src/example.py" }),
        changed.call
      )
    ).rejects.toThrow()
    expect(changed.methods()).toEqual([
      "session.root",
      "process.run",
      "fs.read",
      "session.root",
      "process.run"
    ])
    reads = 0
    const unrelated = host({
      state: () =>
        stateResult({
          checkout: row(),
          other: row("other", { updated_at: ++reads === 1 ? "before" : "after" })
        })
    })
    const result = await run(
      runtime,
      "autobiz-fullstack-prepare-review",
      actionArgs({ feature: "checkout", path: "src/example.py" }),
      unrelated.call
    )
    expect(output(output(result.value).output).feature).toBe("checkout")
    expect(unrelated.methods()).not.toContain("model.complete")
  })

  const invalidInputs: ModObject[] = [
    { path: "src/example.py" },
    { feature: "checkout", path: "STATE.md" },
    { feature: "checkout", path: "src/example.py", workspace: "/external/project" }
  ]
  it.each(invalidInputs)(
    "rejects missing selection, protected path, or external-workspace input before any SDK call",
    async (input) => {
      const { runtime } = await guest(["review-input"])
      const observed = host()
      await expect(
        run(runtime, "autobiz-fullstack-prepare-review", actionArgs(input), observed.call)
      ).rejects.toThrow()
      expect(observed.methods()).toEqual([])
    }
  )
})
