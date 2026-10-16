import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  root: "",
  configured: true,
  selected: [] as Array<{
    deployUnitId: string
    deployUnitIdMapping: string
    localRepoPath: string
  }>
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => {},
  readHarnessProjectContextsInWorker: async () => ({
    projects: {
      p: {
        project: {
          projectId: "p",
          name: "project",
          projectCode: "project",
          projectDir: "project",
          workspacePath: state.root,
          lifecycle: { status: "active" },
          "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
        },
        plugin: { id: "plugin", name: "plugin", path: state.root, version: "1.0.0" },
        sessionContextInjectionSource: "plugin",
        selectedDeployUnits: state.selected,
        configSnapshot: {
          error: null,
          value: {
            apiVersion: 1,
            inspectCommands: {
              [process.platform]: state.configured
                ? {
                    session_context_inject: `"${process.execPath}" "${join(state.root, "context.cjs")}"`
                  }
                : {}
            }
          }
        }
      }
    }
  })
}))

import { buildHarnessFeatureAgentContext } from "./service"
import { HarnessRequiredContextError } from "./context-integrity"

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "cmb-s0-context-"))
  state.selected = []
  state.configured = true
  await mkdir(join(state.root, "board_core"))
})
afterEach(() => rm(state.root, { recursive: true, force: true }))

async function context(payload: unknown) {
  await writeFile(
    join(state.root, "context.cjs"),
    `console.log(${JSON.stringify(JSON.stringify(payload))})`
  )
  return buildHarnessFeatureAgentContext({ harnessFeature: { projectId: "p", slug: "f" } })
}
const report = (id: string, loaded: boolean, required?: boolean) => ({
  deployUnitId: id,
  path: `${id}.md`,
  source: "local",
  loaded,
  message: "",
  ...(required === undefined ? {} : { required })
})

it.each([true, false])(
  "preserves task.enabled=%s and the existing request-input policy from real adapter JSON",
  async (enabled) => {
    const result = await context({
      ok: true,
      sessionContext: "team constraints",
      agentConfig: {
        toolConfig: { task: { enabled }, requestUserInput: { allowAutoResolution: false } }
      }
    })
    expect(result?.agentConfig?.toolConfig).toMatchObject({
      task: { enabled },
      requestUserInput: { allowAutoResolution: false }
    })
    expect(result?.harnessAgentsPrompt).toBe("team constraints")
  }
)

it("blocks partial required knowledge even when the adapter reports ok and emits a prompt", async () => {
  await expect(
    context({
      ok: true,
      sessionContext: "incomplete context",
      agentmdLoadStatus: [report("loaded", true), report("missing", false)]
    })
  ).rejects.toBeInstanceOf(HarnessRequiredContextError)
})

it.each([false, "malformed"])(
  "never converts required failure or invalid load reports into a usable fallback: %s",
  async (mode) => {
    await expect(
      context({
        ok: mode === "malformed",
        sessionContext: "incomplete context",
        agentmdLoadStatus: mode === "malformed" ? [null, {}] : [report("required-team", false)]
      })
    ).rejects.toBeInstanceOf(HarnessRequiredContextError)
  }
)

it("keeps explicitly optional degradation visible without discarding the usable context", async () => {
  const result = await context({
    ok: true,
    sessionContext: "usable context",
    agentmdLoadStatus: [report("loaded", true), report("optional", false, false)]
  })
  expect(result?.harnessAgentsPrompt).toBe("usable context")
  expect(result?.agentmdLoadStatus?.[1]).toMatchObject({ loaded: false, required: false })
})

it.each([true, false])(
  "blocks omitted selected knowledge instead of a framework fallback: ok=%s",
  async (ok) => {
    state.selected = [
      {
        deployUnitId: "required-unit",
        deployUnitIdMapping: "required-unit",
        localRepoPath: state.root
      }
    ]
    await expect(
      context({ ok, sessionContext: "unrelated context", agentmdLoadStatus: [] })
    ).rejects.toBeInstanceOf(HarnessRequiredContextError)
  }
)

it("blocks missing injection commands and empty successful payloads for selected required knowledge", async () => {
  state.selected = [
    {
      deployUnitId: "required-unit",
      deployUnitIdMapping: "required-unit",
      localRepoPath: state.root
    }
  ]
  state.configured = false
  await expect(context({ ok: true })).rejects.toBeInstanceOf(HarnessRequiredContextError)
  state.configured = true
  await expect(
    context({ ok: true, sessionContext: "", agentmdLoadStatus: [report("required-unit", true)] })
  ).rejects.toBeInstanceOf(HarnessRequiredContextError)
})
