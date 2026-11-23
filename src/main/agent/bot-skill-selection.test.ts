import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createMiddleware, FakeToolCallingModel } from "langchain"
import ts from "typescript"

const catalog = vi.hoisted(() => ({ roots: [] as string[], disabled: [] as string[] }))
vi.mock("../storage", async (original) => ({
  ...(await original<typeof import("../storage")>()),
  getEnabledSkillsSources: async () => catalog.roots,
  getEnabledPluginSkillSourceMetadata: () => [],
  getDisabledSkillDirs: () => catalog.disabled
}))
import { LocalSandbox } from "./local-sandbox"
import { SkillLifecycleRegistry } from "./skill-lifecycle/registry"
import { createDeepAgent } from "./runtime"
import { resolveAllowedSkillRootDirs } from "./library/runtime-capabilities"
import {
  prepareStandardThreadRuntimeFactory,
  prepareStandardUserPrompt,
  validateExplicitSkillReference
} from "./standard-thread-turn"
import { createHookScope } from "../hooks/scope"
import { createSkillUseTracker } from "./skill-lifecycle/tracker"
import { formatSkillUseBlock } from "../../shared/skill-use-block"

let root: string, source: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bot-skill-selection-"))
  source = join(root, "skills")
  for (const name of ["review", "deploy"]) {
    mkdirSync(join(source, name), { recursive: true })
    writeFileSync(
      join(source, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name} content`
    )
  }
  catalog.roots = [source]
  catalog.disabled = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it("filters registered file reads, catalog downloads, aliases, and exact explicit activation", async () => {
  const backend = new LocalSandbox({ rootDir: root, windowsSandbox: "none" })
  backend.setSkillLifecycleRegistry(new SkillLifecycleRegistry([source]))
  backend.setAllowedSkillNames(["review"])
  const review = join(source, "review", "SKILL.md"),
    deploy = join(source, "deploy", "SKILL.md")
  expect(await backend.read(review)).toContain("review content")
  expect(await backend.read(deploy)).toContain("skill is disabled")
  const alias = join(root, "alias")
  symlinkSync(join(source, "deploy"), alias)
  expect(await backend.read(join(alias, "SKILL.md"))).toContain("skill is disabled")
  expect((await backend.lsInfo(source)).map((entry) => entry.path.replace(/\/$/, ""))).toContain(
    join(source, "review")
  )
  expect(
    (await backend.lsInfo(source)).map((entry) => entry.path.replace(/\/$/, ""))
  ).not.toContain(join(source, "deploy"))
  expect((await backend.downloadFiles([review, deploy])).map((file) => file.error)).toEqual([
    null,
    "permission_denied"
  ])
  // Claims use the resolved path's actual skill, never the supplied name alone.
  expect(
    await validateExplicitSkillReference({ name: "review", path: deploy }, undefined, ["review"])
  ).toContain("当前可用范围")
  expect(
    await validateExplicitSkillReference({ name: "review", path: review }, undefined, ["review"])
  ).toBeNull()
  catalog.disabled = [join(source, "review")]
  expect(
    await validateExplicitSkillReference({ name: "review", path: review }, undefined, ["review"])
  ).toContain("已禁用")
  backend.setHiddenSkillDirs(catalog.disabled)
  expect(await backend.read(review)).toContain("skill is disabled")
  backend.setAllowedSkillNames(undefined)
  expect(await backend.read(deploy)).toContain("deploy content")
  expect(await backend.read(review)).toContain("skill is disabled")
})

it.each(["message", "trusted"] as const)(
  "rejects a disallowed %s selection before hooks or model execution",
  async (kind) => {
    const skill = { name: "deploy", path: join(source, "deploy", "SKILL.md") }
    const hook = vi.fn(),
      activated = vi.fn()
    const tracker = createSkillUseTracker()
    const result = await prepareStandardUserPrompt({
      rawMessage: kind === "message" ? formatSkillUseBlock(skill) : "Work",
      initialModelInput: "Work",
      ...(kind === "trusted" ? { trustedExplicitSkill: skill } : {}),
      allowedSkillNames: ["review"],
      threadId: "t",
      workspacePath: root,
      turnState: {
        hookScope: createHookScope(),
        skillUseTracker: tracker,
        skillHookKeys: new Set()
      },
      harnessAgentContext: {},
      onHookResult: hook,
      onHookSkippedFactory: () => vi.fn(),
      onExplicitSkillActivated: activated
    })
    expect(result).toMatchObject({ accepted: false, blockedBy: "explicit_skill" })
    expect(hook).not.toHaveBeenCalled()
    expect(activated).not.toHaveBeenCalled()
    expect(tracker.getUsedSkillNames()).toEqual([])
  }
)

it("activates a host-selected skill in the executor scope and retains its directive after preparation", async () => {
  const skill = { name: "review", path: join(source, "review", "SKILL.md") }
  const scope = createHookScope(), tracker = createSkillUseTracker(), activated = vi.fn()
  const state = { hookScope: scope, skillUseTracker: tracker, skillHookKeys: new Set<string>() }
  const prepare = () => prepareStandardUserPrompt({
    rawMessage: "Bot routing note", initialModelInput: "Bot routing note\nHost-linked input",
    trustedExplicitSkill: skill, allowExplicitSkillFromMessage: false, allowedSkillNames: ["review"],
    threadId: "independent-worker", workspacePath: root, turnState: state,
    harnessAgentContext: {}, onHookResult: vi.fn(), onHookSkippedFactory: () => vi.fn(),
    onExplicitSkillActivated: activated
  })
  const result = await prepare()
  expect(result.accepted).toBe(true)
  if (!result.accepted) throw new Error(result.reason)
  expect(result.content).toContain("<name>review</name>")
  expect(result.content).toContain(skill.path)
  expect(scope.activeSkillNames.has("review")).toBe(true)
  expect(tracker.getPendingPostSkillUses()).toMatchObject([{ name: "review", trigger: "explicit", triggerToolName: "skill_select" }])
  expect(activated).toHaveBeenCalledOnce()
  await prepare() // A live correction must not duplicate the skill lifecycle within the run.
  expect(state.skillHookKeys.size).toBe(1)
  expect(tracker.getPendingPostSkillUses()).toHaveLength(1)
})

it("does not treat a worker's generated marker as an explicit selection", async () => {
  const tracker = createSkillUseTracker(), scope = createHookScope()
  const message = formatSkillUseBlock({ name: "review", path: join(source, "review", "SKILL.md") })
  await prepareStandardUserPrompt({ rawMessage: message, initialModelInput: message,
    allowExplicitSkillFromMessage: false, threadId: "worker", workspacePath: root,
    turnState: { hookScope: scope, skillUseTracker: tracker, skillHookKeys: new Set() },
    harnessAgentContext: {}, onHookResult: vi.fn(), onHookSkippedFactory: () => vi.fn() })
  expect(scope.activeSkillNames.size).toBe(0)
  expect(tracker.getUsedSkillNames()).toEqual([])
})

it("refreshes a checkpointed catalog when all becomes selected, none, or all again", async () => {
  const checkpointer = new MemorySaver(),
    prompts: string[] = []
  for (const selection of [undefined, ["review"], [], undefined]) {
    const backend = new LocalSandbox({ rootDir: root, windowsSandbox: "none" })
    backend.setSkillLifecycleRegistry(new SkillLifecycleRegistry([source]))
    backend.setAllowedSkillNames(selection)
    const agent = createDeepAgent({
      model: new FakeListChatModel({ responses: ["done"] }),
      backend,
      checkpointer,
      skills: selection?.length === 0 ? [] : [source],
      allowedSkillRootDirs:
        selection === undefined
          ? undefined
          : await resolveAllowedSkillRootDirs([source], selection),
      middleware: [
        createMiddleware({
          name: "capture",
          wrapModelCall: (request, handler) => {
            prompts.push(JSON.stringify(request.systemMessage.content))
            return handler(request)
          }
        })
      ],
      mainFilesystemEnabled: false,
      mainTodosEnabled: false,
      mainSubagentsEnabled: false,
      includeGeneralPurposeSubagent: false
    })
    await agent.invoke(
      { messages: [new HumanMessage("Work")] },
      { configurable: { thread_id: "same-thread" } }
    )
  }
  expect(prompts[0]).toContain("**deploy**")
  expect(prompts[1]).toContain("**review**")
  expect(prompts[1]).not.toContain("**deploy**")
  expect(prompts[2]).not.toContain("**review**")
  expect(prompts[2]).not.toContain("**deploy**")
  expect(prompts[3]).toContain("**deploy**")
})

it("intersects runtime policy with existing restrictions through model failover", () => {
  const factory = prepareStandardThreadRuntimeFactory({
    source: "bot",
    runLease: { owner: "bot", runId: "r" },
    baseOptions: { threadId: "t", workspacePath: root, allowedSkillNames: ["review"] },
    remotePolicy: { allowedSkillNames: ["deploy"] }
  })
  expect(factory.optionsForModel("primary").allowedSkillNames).toEqual([])
  expect(factory.optionsForModel("fallback").allowedSkillNames).toEqual([])
})

it("all recursively constructed workflow/worker/failover/handoff runtimes carry the effective selection", () => {
  const file = ts.createSourceFile(
    "runtime.ts",
    readFileSync(new URL("./runtime.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  let calls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(file) === "createAgentRuntime") {
      calls++
      const arg = node.arguments[0]
      expect(ts.isObjectLiteralExpression(arg)).toBe(true)
      if (ts.isObjectLiteralExpression(arg)) {
        const field = arg.properties.find(
          (prop) => prop.name?.getText(file) === "allowedSkillNames"
        )
        expect(field && ts.isPropertyAssignment(field) && field.initializer.getText(file)).toBe(
          "sessionAllowedSkillNames"
        )
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  expect(calls).toBe(4)
})

it("task subagents with their own skill sources receive the selected catalog and file loader", async () => {
  const backend = new LocalSandbox({ rootDir: root, windowsSandbox: "none" })
  backend.setSkillLifecycleRegistry(new SkillLifecycleRegistry([source]))
  backend.setAllowedSkillNames(["review"])
  const childPrompts: string[] = []
  const agent = createDeepAgent({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            id: "delegate",
            name: "task",
            args: { subagent_type: "reviewer", description: "Review this task" }
          }
        ],
        []
      ]
    }),
    backend,
    skills: [source],
    allowedSkillRootDirs: await resolveAllowedSkillRootDirs([source], ["review"]),
    mainTodosEnabled: false,
    mainFilesystemEnabled: false,
    includeGeneralPurposeSubagent: false,
    subagents: [
      {
        name: "reviewer",
        description: "Review",
        systemPrompt: "Review carefully",
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        skills: [source],
        middleware: [
          createMiddleware({
            name: "captureChild",
            wrapModelCall: (request, handler) => {
              childPrompts.push(JSON.stringify(request.systemMessage.content))
              return handler(request)
            }
          })
        ]
      }
    ]
  })
  await agent.invoke({ messages: [new HumanMessage("Delegate a review")] })
  expect(childPrompts.length).toBeGreaterThan(0)
  expect(childPrompts[0]).toContain("**review**")
  expect(childPrompts[0]).not.toContain("**deploy**")
})
