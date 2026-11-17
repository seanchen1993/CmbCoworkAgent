import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AIMessage } from "@langchain/core/messages"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesignRunDependencies } from "../services/design/run-manager"
import type {
  DesignRunEvent,
  DesignRunRequest,
  DesignSessionSnapshot,
  TabState
} from "../../shared/managed-design-session"
import type { createAgentRuntime } from "../agent/runtime"
import { LocalSandbox } from "../agent/local-sandbox"
import { DesignPatchScopeError } from "../services/design/patch-context"
import { DesignPatchLayoutScopeError, type PatchExecutorOptions } from "../services/design/patch-executor"
import {
  DESIGN_CREATION_SYSTEM_PROMPT,
  DESIGN_ITERATION_SYSTEM_PROMPT
} from "../services/design/generation-prompt"

type RuntimeOptions = Parameters<typeof createAgentRuntime>[0]
const mocks = vi.hoisted(() => ({
  root: "",
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  runtime: vi.fn(),
  patch: vi.fn(),
  validate: vi.fn(),
  deps: null as DesignRunDependencies | null,
  snapshot: null as DesignSessionSnapshot | null
}))
vi.mock("electron", () => ({
  ipcMain: {
    on: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler)
  },
  app: { on: vi.fn(), getPath: () => mocks.root, getAppPath: () => mocks.root },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: {}
}))
vi.mock("electron-store", () => ({
  default: class {
    get() {
      return null
    }
  }
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => mocks.root,
  deleteThreadCheckpoint: vi.fn(),
  getCustomModelConfigs: () => [{ id: "test", apiKey: "test" }]
}))
vi.mock("../db", () => ({ getDb: vi.fn() }))
vi.mock("../agent/runtime", () => ({
  createAgentRuntime: mocks.runtime,
  closeCheckpointer: vi.fn(),
  getModelInstance: () => ({}),
  createRetryingFetch: vi.fn()
}))
vi.mock("../services/design/model-config", () => ({
  getDesignModelConfig: () => ({ model: "test", apiKey: "test", baseUrl: "http://mock.invalid/v1" })
}))
vi.mock("../agent/approval-decision-broker", () => ({
  approvalDecisionBroker: { subscribePending: vi.fn(), subscribeRemoved: vi.fn() }
}))
vi.mock("../services/design/session-store", () => ({ DesignSessionStore: class {} }))
vi.mock("../services/design/run-manager", () => ({
  DesignRunManager: class {
    constructor(_store: unknown, deps: DesignRunDependencies) {
      mocks.deps = deps
    }
    get() {
      return mocks.snapshot
    }
  }
}))
vi.mock("./design-url-import", () => ({ registerDesignUrlImportHandlers: vi.fn() }))
vi.mock("./design-system-library", () => ({ registerDesignSystemLibraryHandlers: vi.fn() }))
vi.mock("../services/design/patch-executor", async (original) => ({
  ...(await original<typeof import("../services/design/patch-executor")>()),
  executeDesignPatch: mocks.patch
}))
vi.mock("../services/design/browser-validation-runner", async (original) => ({
  ...(await original<typeof import("../services/design/browser-validation-runner")>()),
  validateDesignBrowserWithRetry: mocks.validate
}))

import { registerDesignHandlers } from "./design"

const baseline =
  '<!DOCTYPE html><html><head><link rel="stylesheet" href="./assets/app.css"><style>body{font-family:Arial;margin:12px}.sidebar{width:180px}</style></head><body><nav id="sidebar">原导航</nav><main><h1>原页面</h1><button id="export">导出</button></main><script>window.originalBehavior=true</script></body></html>'
const edited = baseline.replace('id="export"', 'id="export" onclick="window.exported=true"')
const temporary: string[] = []
let turns: Array<{ options: RuntimeOptions; message: string; draft: string }>
let onTurn: (turn: (typeof turns)[number]) => Promise<void>
let replyText: string
let turnErrors: unknown[]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "design-iteration-"))
  temporary.push(mocks.root)
  mocks.handlers.clear()
  mocks.validate.mockResolvedValue({ ok: true, issues: [] })
  turns = []
  turnErrors = []
  replyText = "处理已结束"
  onTurn = async () => {}
  mocks.runtime.mockImplementation(async (options: RuntimeOptions) => ({
    stream: async (input: { messages: Array<{ content: string }> }) =>
      (async function* () {
        const message = input.messages[0].content
        const draft = message.match(
          /(?:DESIGN (?:ARTIFACT FILE|CONTINUATION ARTIFACT)|唯一修复目标（文件已存在）：)\n([^\n]+)/
        )?.[1]
        if (!draft) throw new Error("Missing working artifact path")
        const turn = { options, message, draft }
        turns.push(turn)
        try {
          await onTurn(turn)
        } catch (error) {
          turnErrors.push(error)
          throw error
        }
        yield ["values", { messages: [new AIMessage(replyText)] }]
      })()
  }))
  registerDesignHandlers()
})
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function edit(turn: (typeof turns)[number], before: string, after: string) {
  const sandbox = new LocalSandbox({
    rootDir: mocks.root,
    runId: "iteration-test",
    validateFileWrite: turn.options.validateFileWrite,
    onFileMutation: turn.options.onFileMutation
  })
  await sandbox.read(turn.draft, 0, 10)
  expect((await sandbox.edit(turn.draft, before, after)).error).toBeUndefined()
}

async function run(
  overrides: Partial<DesignRunRequest> = {},
  html = baseline,
  state: Partial<TabState> = {}
) {
  mocks.snapshot = {
    id: "ds_iteration",
    workspacePath: mocks.root,
    state: { html, tweaks: null, artifactRevision: 0, ...state }
  } as DesignSessionSnapshot
  const events: DesignRunEvent[] = []
  await mocks.deps!.execute(
    {
      requestId: "request",
      designSessionId: mocks.snapshot.id,
      kind: "agent",
      isIteration: !!html,
      prompt: "User follow-up instruction: 在原页面上新增导出功能，不要整体重构",
      ...overrides
    },
    "iteration-run",
    (event) => events.push(event),
    mocks.snapshot
  )
  // The IPC handler reports runtime failures as events; fixture assertions must still fail the test.
  if (turnErrors.length) throw turnErrors[0]
  return events
}

describe("existing page generation", () => {
  it("shows the model's candidate summary before local patch validation", async () => {
    mocks.patch.mockImplementationOnce(async (options: PatchExecutorOptions) => {
      options.onProposal!("将标题字号调整为 24px")
      options.status({ phase: "validating", message: "正在校验局部修改与页面交互" })
      return { candidate: { html: baseline, patch: { summary: "将标题字号调整为 24px" } } }
    })
    const events = await run({
      kind: "patch",
      patch: { targets: [], variationId: null, artifactRevision: 0 }
    })
    const responseIndex = events.findIndex((event) => event.type === "token")
    expect(events[responseIndex]).toMatchObject({ token: "候选修改：将标题字号调整为 24px\n" })
    expect(events[responseIndex].displayText).not.toBe(false)
    expect(responseIndex).toBeLessThan(events.findIndex((event) => event.patchStatus?.phase === "validating"))
    expect(events.some((event) => event.type === "done")).toBe(true)
  })

  it("edits a restored page through the sandbox without loading creation guidance", async () => {
    onTurn = async (turn) => {
      expect(fs.readFileSync(turn.draft, "utf8")).toBe(baseline)
      expect(turn.options.extraSystemPrompt).toBe(DESIGN_ITERATION_SYSTEM_PROMPT)
      expect(turn.options.baseSystemPrompt).toContain("editing the user's existing")
      expect(turn.options.blockedToolNames).toEqual(
        expect.arrayContaining(["write_file", "execute", "code_exec"])
      )
      expect(
        turn.options.validateFileWrite!(path.join(mocks.root, "other.html"), edited)
      ).toContain("仅修改当前页面草稿")
      expect(turn.message).not.toContain("small closed scaffold")
      await edit(
        turn,
        '<button id="export">',
        '<button id="export" onclick="window.exported=true">'
      )
    }
    const events = await run({}, baseline, {
      sourceInfo: { kind: "import_url", label: "原页面", detail: "https://example.com/original" }
    })
    expect(turns).toHaveLength(1)
    expect(events.find((event) => event.type === "done")?.html).toBe(edited)
    expect(
      fs.readFileSync(
        path.join(mocks.root, ".cmb-design/ds_iteration_design-main/index.html"),
        "utf8"
      )
    ).toContain("window.originalBehavior=true")
  })

  it("keeps the same editing contract when a local patch needs new behavior", async () => {
    mocks.patch.mockRejectedValue(new DesignPatchScopeError("需要新增业务行为"))
    onTurn = (turn) => edit(turn, "导出</button>", "导出报表</button>")
    const events = await run({
      kind: "patch",
      patch: { targets: [], variationId: null, artifactRevision: 0 }
    })
    expect(events.some((event) => event.patchStatus?.phase === "expanding")).toBe(true)
    expect(turns[0].options.extraSystemPrompt).toBe(DESIGN_ITERATION_SYSTEM_PROMPT)
    expect(events.some((event) => event.type === "done")).toBe(true)
  })

  it("continues exhausted layout repairs with the original feature request and responsive guidance", async () => {
    const issue = "修改产生横向溢出：parent:controls（视口 390px；父容器 module 宽 82px）"
    mocks.patch.mockRejectedValue(new DesignPatchLayoutScopeError([issue]))
    onTurn = async (turn) => {
      expect(fs.readFileSync(turn.draft, "utf8")).toBe(baseline)
      expect(turn.message).toContain("在原页面上新增导出功能，不要整体重构")
      expect(turn.message).toContain(issue)
      expect(turn.message).toContain("自动换行、扩大可用宽度并让高度随内容增长")
      expect(turn.message).toContain("仅调整相关模块及必要的父容器布局")
      await edit(turn, "导出</button>", "导出报表</button>")
    }
    const events = await run({
      kind: "patch",
      patch: { targets: [], variationId: null, artifactRevision: 0 }
    })
    expect(turns).toHaveLength(1)
    expect(turns[0].options.extraSystemPrompt).toBe(DESIGN_ITERATION_SYSTEM_PROMPT)
    expect(events.some((event) => event.patchStatus?.phase === "expanding")).toBe(true)
    expect(events.some((event) => event.type === "error")).toBe(false)
    expect(events.find((event) => event.type === "done")?.html).toBe(
      baseline.replace("导出</button>", "导出报表</button>")
    )
  })

  it("never accepts a seeded but unedited page and preserves the editing contract on recovery", async () => {
    // Returning replacement HTML in chat must not bypass edits to the working file.
    replyText = baseline.replace("原页面", "聊天中重新生成的页面")
    const events = await run()
    expect(events.some((event) => event.type === "done")).toBe(false)
    expect(mocks.validate).not.toHaveBeenCalled()
    const recovery = turns.filter((turn) => turn.message.includes("[Artifact edit recovery]"))
    expect(recovery).toHaveLength(2)
    expect(new Set(recovery.map((turn) => turn.draft)).size).toBe(2)
    for (const turn of turns) {
      expect(turn.options.extraSystemPrompt).toBe(DESIGN_ITERATION_SYSTEM_PROMPT)
      expect(fs.readFileSync(turn.draft, "utf8")).toBe(baseline)
      expect(turn.message).not.toContain("Create it with write_file")
    }
  })

  it("seeds from a source file when no inline HTML is supplied", async () => {
    const source = path.join(mocks.root, "imported.html")
    fs.writeFileSync(source, baseline)
    onTurn = async (turn) => {
      expect(fs.readFileSync(turn.draft, "utf8")).toBe(baseline)
      await edit(turn, "导出</button>", "导出报表</button>")
    }
    const events = await run({ isIteration: true, sourceArtifactPath: source }, "")
    expect(events.find((event) => event.type === "done")?.html).toBe(
      baseline.replace("导出</button>", "导出报表</button>")
    )
    expect(fs.readFileSync(source, "utf8")).toBe(baseline)
  })

  it("rejects tracked writes that leave a file-only source unchanged", async () => {
    const source = path.join(mocks.root, "imported.html")
    fs.writeFileSync(source, baseline)
    onTurn = (turn) => edit(turn, "</html>", "</html>\n")
    const events = await run({ isIteration: true, sourceArtifactPath: source }, "")
    expect(events.some((event) => event.type === "done")).toBe(false)
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === "error")).toBe(true)
  })

  it("finishes an interrupted edit in the same draft while retaining the latest changes", async () => {
    const partial = baseline.replace("<body>", '<body data-design-build="building">')
    onTurn = async (turn) => {
      if (turns.length === 1) await edit(turn, "<body>", '<body data-design-build="building">')
      else {
        expect(fs.readFileSync(turn.draft, "utf8")).toBe(partial)
        expect(turn.draft).toBe(turns[0].draft)
        expect(turn.message).toContain("Edit this file in place")
        await edit(turn, ' data-design-build="building"', ' data-export-enabled="true"')
      }
    }
    const events = await run()
    expect(turns).toHaveLength(2)
    expect(events.some((event) => event.type === "done")).toBe(true)
  })

  it("permits an explicitly requested redesign through the existing working file", async () => {
    onTurn = (turn) => edit(turn, "margin:12px", "margin:32px")
    const events = await run({ prompt: "请重新设计整体布局，加大页面留白" })
    expect(turns[0].options.extraSystemPrompt).toContain(
      "only when the user explicitly requests it"
    )
    expect(events.find((event) => event.type === "done")?.html).toContain("margin:32px")
  })

  it("retains scaffold creation for a new page", async () => {
    onTurn = async (turn) => {
      expect(fs.existsSync(turn.draft)).toBe(false)
      expect(turn.options.extraSystemPrompt).toBe(DESIGN_CREATION_SYSTEM_PROMPT)
      expect(turn.options.blockedToolNames).not.toContain("write_file")
      expect(turn.options.validateFileWrite!(turn.draft, baseline)).toBeUndefined()
      fs.writeFileSync(turn.draft, baseline)
      turn.options.onFileMutation!(turn.draft, "write")
    }
    expect((await run({ prompt: "创建一个页面" }, "")).some((event) => event.type === "done")).toBe(
      true
    )
  })

  it("creates a new design from reference inputs without seeding or freezing the reference page", async () => {
    const referenceFile = path.join(mocks.root, "reference.html")
    fs.writeFileSync(referenceFile, baseline)
    const generated = baseline.replace("margin:12px", "margin:48px").replace("原页面", "新产品设计")
    onTurn = async (turn) => {
      expect(fs.existsSync(turn.draft)).toBe(false)
      expect(turn.options.extraSystemPrompt).toBe(DESIGN_CREATION_SYSTEM_PROMPT)
      expect(turn.options.extraSystemPrompt).toContain("not an existing canvas to edit or preserve")
      expect(turn.options.blockedToolNames).not.toContain("write_file")
      expect(turn.options.validateFileWrite!(turn.draft, generated)).toBeUndefined()
      fs.writeFileSync(turn.draft, generated)
      turn.options.onFileMutation!(turn.draft, "write")
    }
    const events = await run(
      {
        prompt: `参考此页面制作新的产品介绍，可以调整布局和风格。\n参考页面：${referenceFile}\n${baseline}`
      },
      "",
      {
        attachedFiles: [
          {
            filename: "reference.html",
            filePath: referenceFile,
            sourceUrl: "https://example.com/reference",
            content: baseline,
            mimeType: "text/html",
            size: Buffer.byteLength(baseline),
            truncated: false
          }
        ]
      }
    )
    expect(events.find((event) => event.type === "done")?.html).toBe(generated)
    expect(fs.readFileSync(referenceFile, "utf8")).toBe(baseline)
  })

  it("uses the user's own canvas as the baseline when adding a page reference to an existing design", async () => {
    const reference = baseline.replace("原页面", "参考页面").replace("margin:12px", "margin:64px")
    const referenceFile = path.join(mocks.root, "reference.html")
    fs.writeFileSync(referenceFile, reference)
    onTurn = async (turn) => {
      expect(fs.readFileSync(turn.draft, "utf8")).toBe(baseline)
      expect(turn.options.extraSystemPrompt).toBe(DESIGN_ITERATION_SYSTEM_PROMPT)
      expect(turn.options.extraSystemPrompt).toContain(
        "Attached reference pages are read-only guidance"
      )
      expect(turn.message).toContain(reference)
      expect(turn.options.validateFileWrite!(referenceFile, edited)).toContain("仅修改当前页面草稿")
      await edit(turn, "导出</button>", "导出报表</button>")
    }
    const events = await run(
      { prompt: `参考页面的导出入口，给我的当前页面添加导出功能，保留当前风格。\n${reference}` },
      baseline,
      {
        attachedFiles: [
          {
            filename: "reference.html",
            filePath: referenceFile,
            sourceUrl: "https://example.com/reference",
            content: reference,
            mimeType: "text/html",
            size: Buffer.byteLength(reference),
            truncated: false
          }
        ]
      }
    )
    expect(events.find((event) => event.type === "done")?.html).toBe(
      baseline.replace("导出</button>", "导出报表</button>")
    )
    expect(fs.readFileSync(referenceFile, "utf8")).toBe(reference)
  })
})
