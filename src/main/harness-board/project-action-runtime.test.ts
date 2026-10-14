import { expect, it, vi } from "vitest"
import { normalizeProjectActionRuntime } from "./project-action-runtime"
import type { FlowRun, FlowChatTask } from "../../shared/mods/flows/types"
import type { ProjectActionBinding } from "../../shared/project-runtime/action-bindings"
import { FlowManager } from "../mods/flows/manager"
import { FlowStore } from "../mods/flows/store"

it("uses the Mods key for Windows catalog, selection and every Flow lifecycle operation", async () => {
  const raw = "C:\\Users\\Author\\Project"
  const canonical = raw.toLowerCase()
  const normalize = vi.fn((workspace: string) => {
    if (workspace !== raw && workspace !== canonical) throw Error("Unknown workspace")
    return canonical
  })
  const calls: Array<[string, string, unknown[]]> = []
  const record = (name: string, workspace: string, ...args: unknown[]) => {
    expect(workspace).toBe(canonical)
    calls.push([name, workspace, args])
  }
  const bridge = normalizeProjectActionRuntime(
    {
      catalog: async (workspace, thread) => {
        record("catalog", workspace, thread)
        return []
      },
      prepareSelection: async (workspace, thread, bindings) => {
        record("selection", workspace, thread, bindings)
      },
      flows: {
        startSaved: vi.fn(async (workspace, ...args) => {
          record("start", workspace, ...args)
          return {} as FlowRun
        }),
        waitForSettlement: async (workspace, ...args) => {
          record("settle", workspace, ...args)
        },
        run: (workspace, ...args) => {
          record("read", workspace, ...args)
          return null
        },
        cancel: async (workspace, ...args) => {
          record("cancel", workspace, ...args)
        }
      }
    },
    normalize
  )
  const bindings: ProjectActionBinding[] = []
  const saved = { filePath: raw } as unknown as Parameters<typeof bridge.flows.startSaved>[2]
  const task: FlowChatTask = { workspace: raw, goal: "Preserve the original task goal" }
  const guard = vi.fn()
  await bridge.catalog(raw, "thread")
  await bridge.prepareSelection(raw, "thread", bindings)
  await bridge.flows.startSaved(raw, "thread", saved, task, guard)
  await bridge.flows.waitForSettlement(raw, "thread", "run")
  bridge.flows.run(raw, "thread", "run")
  await bridge.flows.cancel(raw, "thread", "run")
  expect(calls.map(([name]) => name)).toEqual([
    "catalog",
    "selection",
    "start",
    "settle",
    "read",
    "cancel"
  ])
  expect(calls[1][2][1]).toBe(bindings)
  expect(calls[2][2][1]).toBe(saved)
  expect(calls[2][2][3]).toBe(guard)
  expect(calls[2][2][2]).toEqual({ workspace: canonical, goal: task.goal })
  expect(task.workspace).toBe(raw)
  expect((saved as unknown as { filePath: string }).filePath).toBe(raw)
  expect(guard).not.toHaveBeenCalled()
  expect(normalize).toHaveBeenCalledTimes(7)
})

it("settles a real Flow when task and lifecycle receive the same canonical Windows workspace", async () => {
  const raw = "C:\\Users\\Author\\FlowProject"
  const key = raw.toLowerCase()
  const settings = new Map<string, string>()
  const flows = new FlowManager(
    new FlowStore({
      getSetting: (name, fallback = "") => settings.get(name) ?? fallback,
      setSetting: (name, value) => {
        settings.set(name, value)
      }
    }),
    {
      assertScope: (workspace) => {
        expect(workspace).toBe(key)
      },
      changed: () => {},
      prepare: async () => ({
        assertLive: () => {},
        fingerprint: async () => "unchanged",
        execute: async () => ({ passed: true, source: "native-check", summary: "checked" }),
        finalize: async (_context, confirm) => {
          await confirm()
          return { passed: true, source: "native-check", summary: "complete" }
        },
        dispose: async () => {}
      })
    }
  )
  const saved = flows.save(
    key,
    {
      schemaVersion: 1,
      id: "path-test",
      name: "path-test",
      plugin: "fixture",
      goal: "bounded check",
      timeoutMs: 10000,
      maxExecutions: 3,
      steps: [{ id: "check", name: "check", enabled: true, kind: "check", check: "unit-test" }]
    },
    0
  )
  const bridge = normalizeProjectActionRuntime(
    { flows, catalog: async () => [], prepareSelection: async () => {} },
    (value) => value.toLowerCase()
  )
  const run = await bridge.flows.startSaved(raw, "windows-normalization-thread", saved, {
    workspace: raw,
    goal: "bounded check"
  })
  await bridge.flows.waitForSettlement(raw, run.threadId, run.id)
  expect(bridge.flows.run(raw, run.threadId, run.id)?.status).toBe("complete")
  expect(flows.runs(key, run.threadId)).toHaveLength(1)
  expect(flows.runs(raw, run.threadId)).toHaveLength(0)
})
