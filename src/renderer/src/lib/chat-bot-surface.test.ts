import { readFileSync } from "node:fs"
import ts from "typescript"
import { describe, expect, it, vi } from "vitest"
import { projectChatSkillCatalog, type SkillCatalogSnapshot } from "./app-catalog-cache"

const chat = source("../components/chat/ChatContainer.tsx")
const store = source("./store.ts")

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(new URL(path, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
}

function find(file: ts.SourceFile, matches: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined
  const visit = (node: ts.Node): void => {
    if (matches(node)) result = node
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!result) throw new Error("Production callback not found")
  return result
}

// Execute production callbacks, replacing only React state, cache/IPC boundaries.
// Do not duplicate the surface predicates or navigation state update in the test.
function compile<T>(node: ts.Node, file: ts.SourceFile, bindings: Record<string, unknown>): T {
  const code = ts.transpileModule(`const callback = ${node.getText(file)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  return new Function(...Object.keys(bindings), `${code}; return callback;`)(
    ...Object.values(bindings)
  )
}

function callback(name: string): ts.Node {
  const declaration = find(
    chat,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(chat) === name
  )
  return ((declaration as ts.VariableDeclaration).initializer as ts.CallExpression).arguments[0]
}

const initialSkills = find(
  chat,
  (node) =>
    ts.isFunctionDeclaration(node) && node.name?.text === "createInitialChatSkillCatalogState"
)
const forkStore = (
  find(
    store,
    (node) => ts.isPropertyAssignment(node) && node.name.getText(store) === "forkThread"
  ) as ts.PropertyAssignment
).initializer

describe("Bot and Harness chat surface boundaries", () => {
  it.each([
    ["default", false, ["bound", "other", "shared"]],
    ["bot", false, ["bound", "other", "shared"]],
    ["harness-project", false, ["shared"]],
    ["harness-feature-session", false, ["shared"]],
    ["default", true, ["bound", "shared"]],
    ["bot", true, ["bound", "shared"]],
    ["harness-project", true, ["bound", "shared"]],
    ["harness-feature-session", true, ["bound", "shared"]]
  ] as const)(
    "keeps skill scope for %s (bound=%s) on mount and refresh",
    async (surface, bound, expected) => {
      const snapshot: SkillCatalogSnapshot = {
        key: "fixture",
        localSkills: [],
        rightPanelSkills: [],
        total: 3,
        rightPanelEnabledSkillCount: 3,
        truncated: false,
        truncatedReasons: [],
        updatedAt: 1,
        disabledSkillIds: new Set<string>(),
        pluginSkills: ["bound", "other", "shared"].map((name) => ({
          id: name,
          name,
          description: name,
          path: `/plugins/${name}/SKILL.md`,
          source: "user",
          version: "1.0.0",
          pluginId: name,
          isProjectModePlugin: name !== "shared"
        }))
      }
      const binding = bound ? { projectId: "project" } : null
      const preferredPlugin = bound ? { id: "bound", name: "Bound" } : null
      const bindings = {
        useAppStore: { getState: () => ({ threads: [], pluginVersion: 1 }) },
        getHarnessFeatureBinding: () => binding,
        getCachedHarnessPreferredPlugin: () => preferredPlugin,
        readSkillCatalogCache: () => snapshot,
        isSkillCatalogFresh: () => true,
        projectChatSkillCatalog
      }
      const initialize = compile<
        (id: string, surface: string) => { projection: { skills: { name: string }[] } }
      >(initialSkills, chat, bindings)
      expect(initialize("thread", surface).projection.skills.map((skill) => skill.name)).toEqual(
        expected
      )

      // Both a fresh cache and a new plugin catalog must use the same scope.
      for (const fresh of [true, false]) {
        const setSkills = vi.fn()
        const load = compile<() => Promise<void>>(callback("loadSkills"), chat, {
          ...bindings,
          isSkillCatalogFresh: () => fresh,
          skillsLoadRequestIdRef: { current: 0 },
          harnessFeatureBindingRef: { current: binding },
          chatSurfaceRef: { current: surface },
          readHarnessBoardCatalogCache: () => null,
          revalidateSkillCatalog: async () => snapshot,
          window: {
            api: {
              harnessBoard: {
                catalogPage: async () => ({
                  projects: [{ projectId: "project", harnessAdapter: preferredPlugin }]
                })
              }
            }
          },
          setSkills,
          setSkillsLoadTargetProjectId: vi.fn(),
          setDisabledSkillIds: vi.fn(),
          setSkillsHarnessProjectId: vi.fn(),
          setSkillsHarnessPreferredPlugin: vi.fn(),
          setSkillsLoading: vi.fn()
        })
        await load()
        expect(setSkills.mock.lastCall?.[0].map((skill: { name: string }) => skill.name)).toEqual(
          expected
        )
      }
    }
  )

  it.each(["default", "bot", "harness-project", "harness-feature-session"])(
    "navigates a fork from %s using its existing destination",
    async (surface) => {
      const harness = surface.startsWith("harness-")
      let state = {
        mainView: surface === "bot" ? "bots" : "thread",
        showHarnessBoardView: harness,
        currentThreadId: "old",
        threads: [{ thread_id: "old" }]
      }
      const forkApi = vi.fn(async () => ({ thread: { thread_id: "new" } }))
      const fork = compile<(params: unknown, options?: unknown) => Promise<{ thread_id: string }>>(
        forkStore,
        store,
        {
          window: { api: { threads: { fork: forkApi } } },
          markThreadDirectoryMutation: vi.fn(),
          adoptThreadDirectorySnapshot: (threads: unknown) => threads,
          set: (update: (previous: typeof state) => Partial<typeof state>) => {
            state = { ...state, ...update(state) }
          }
        }
      )
      const navigateHarness = vi.fn()
      const success = vi.fn(),
        error = vi.fn()
      const run = compile<() => Promise<void>>(callback("handleConfirmMessageFork"), chat, {
        messageForkTarget: {
          sourceThreadId: "old",
          message: { id: "message" },
          checkpoint: { checkpointId: "checkpoint", messageForkMode: "checkpoint" }
        },
        forkingMessageId: null,
        currentThreadIdRef: { current: "old" },
        forkWorkspacePath: "/new-workspace",
        forkDestinationMode: "workspace",
        handleSelectForkWorkspace: vi.fn(),
        surface,
        setForkingMessageId: vi.fn(),
        forkThread: fork,
        onHarnessSessionCreated: harness ? navigateHarness : undefined,
        toast: { success, error },
        resetMessageForkDialog: vi.fn(),
        getMessageForkCheckpointHint: String
      })
      await run()
      expect(error).not.toHaveBeenCalled()
      expect(success).toHaveBeenCalledOnce()
      expect(forkApi).toHaveBeenCalledExactlyOnceWith({
        sourceThreadId: "old",
        checkpointId: "checkpoint",
        overrides: { workspacePath: "/new-workspace" }
      })
      expect(state.currentThreadId).toBe("new")
      expect(state.showHarnessBoardView).toBe(harness)
      expect(state.threads.map((thread) => thread.thread_id)).toEqual(["new", "old"])
      if (harness) expect(navigateHarness).toHaveBeenCalledExactlyOnceWith("new")
      else {
        expect(state.mainView).toBe("thread")
        expect(navigateHarness).not.toHaveBeenCalled()
      }
    }
  )
})
