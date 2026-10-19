import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { PluginHookMetadata, PluginMetadata } from "../types"

const state = vi.hoisted(() => ({ hooks: [] as PluginHookMetadata[] }))
vi.mock("../storage", () => ({ parsePluginHooks: () => state.hooks }))
import { readRuntimeRequiredHooks } from "./runtime-required-hooks"
import { reviewedAutobizRequiredHookIds } from "./autobiz-required-hooks"
import {
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../../shared/project-runtime"

const roots: string[] = []
afterEach(async () => {
  state.hooks = []
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), "cmb-required-hooks-"))
  roots.push(path)
  return { id: "source", path, name: "source", enabled: true } as PluginMetadata
}
const hook = (id: string, event = "PreToolUse", blocking = true) =>
  ({
    id: `plugin:source/${id}`,
    enabled: true,
    event,
    type: "command",
    ...(blocking ? { onBlock: { reason: "business check" } } : {})
  }) as PluginHookMetadata

it("binds declared parent checks and rejects omitted implementations", async () => {
  const plugin = await fixture()
  await writeFile(
    join(plugin.path, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "flow",
          title: "Business",
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json",
          requiredHooks: ["guard"]
        }
      ]
    })
  )
  expect(() => readRuntimeRequiredHooks(plugin)).toThrow("PROJECT_REQUIRED_HOOK_MISSING")
  state.hooks = [hook("guard")]
  expect(readRuntimeRequiredHooks(plugin)).toEqual(["plugin:source/guard"])
  state.hooks[0].enabled = false
  expect(() => readRuntimeRequiredHooks(plugin)).toThrow("PROJECT_REQUIRED_HOOK_MISSING")
})

it("preserves explicit old business gates only for the admitted legacy adapter", async () => {
  const plugin = await fixture()
  state.hooks = [hook("gate"), hook("observe", "PostToolUse", false), hook("stop", "Stop")]
  expect(readRuntimeRequiredHooks(plugin, { legacy: true })).toEqual([])
  await writeFile(
    join(plugin.path, "devclaw.stage-checks.json"),
    JSON.stringify({
      apiVersion: "devclaw.stage-check-adapter/v1",
      adapter: "autobiz-v1"
    })
  )
  expect(readRuntimeRequiredHooks(plugin)).toEqual([])
  expect(readRuntimeRequiredHooks(plugin, { legacy: true })).toEqual(["plugin:source/gate"])
})

it("selects a host Skill's declaration without imposing unrelated Skill checks", async () => {
  const plugin = await fixture()
  await writeFile(
    join(plugin.path, "devclaw.capabilities.json"),
    JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: ["one", "two"].map((id) => ({
        id,
        title: id,
        kind: "skill",
        usage: "project",
        entry: `skills/${id}/SKILL.md`,
        requiredHooks: [id]
      }))
    })
  )
  state.hooks = [hook("one")]
  expect(readRuntimeRequiredHooks(plugin, { entry: "skills/one/SKILL.md" })).toEqual([
    "plugin:source/one"
  ])
})

it("requires a complete explicit declaration for the reviewed v2 AutoBiz kernel", async () => {
  const plugin = await fixture()
  const bytes = await readFile(
    new URL("../../../tests/fixtures/autobiz-reviewed-hooks.json", import.meta.url)
  )
  const required = reviewedAutobizRequiredHookIds(JSON.parse(bytes.toString("utf8")))
  await mkdir(join(plugin.path, "hooks"))
  await mkdir(join(plugin.path, "board_core"))
  await writeFile(join(plugin.path, "hooks/hooks.json"), bytes)
  await writeFile(join(plugin.path, "board_core/board_config.json"), '{"apiVersion":2}')
  await writeFile(
    join(plugin.path, "devclaw.stage-checks.json"),
    JSON.stringify({
      apiVersion: "devclaw.stage-check-adapter/v1",
      adapter: "autobiz-v1"
    })
  )
  await writeFile(
    join(plugin.path, "devclaw.project-runtime.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-runtime/v2",
      runtime: {
        apiVersion: "devclaw.project-runtime/v1",
        plugin: { id: "source", version: "1" },
        mode: "legacy",
        stateOwner: "plugin",
        stages: [],
        actions: [],
        artifacts: [],
        checks: [],
        environment: [],
        capabilities: {
          execution: true,
          conditionalTransition: false,
          idempotency: false,
          reconciliation: false,
          cancellation: true
        }
      },
      extensionContract: {
        apiVersion: EXTENSION_CONTRACT_API_VERSION,
        requires: [REQUIRED_BUSINESS_CHECKS_PROTOCOL]
      }
    })
  )
  const write = (ids: string[]) =>
    writeFile(
      join(plugin.path, "devclaw.capabilities.json"),
      JSON.stringify({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: "flow",
            title: "AutoBiz",
            kind: "flow",
            usage: "project",
            entry: "devclaw.project-runtime.json",
            requiredHooks: ids
          }
        ]
      })
    )
  state.hooks = required.map((id) => hook(id))
  await write(required.slice(1))
  expect(() => readRuntimeRequiredHooks(plugin, { legacy: true })).toThrow("DECLARATION_INCOMPLETE")
  await write(required)
  expect(readRuntimeRequiredHooks(plugin, { legacy: true })).toEqual(
    required.map((id) => `plugin:source/${id}`)
  )
})
