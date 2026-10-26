import type { ProjectFunctionDependencyReview } from "../../shared/project-runtime/function-source"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import type { FunctionModsManager } from "../mods/v2/manager"
import type { ModPluginSource } from "../mods/manager"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { assertConfigurationSourcesCurrent } from "../mods/v2/configuration-source-cache"
import { readProjectRuntimeDescription } from "./project-runtime/description"
import { readProjectActionLock } from "./project-runtime/action-input"

/** Native review resolves only exact providers in the retained project action lock. */
export function projectRuntimeDependencies(input: {
  root: string
  workspace: string
  manager: FunctionModsManager
  plugins(): readonly ModPluginSource[]
  assertCurrent(): void
}) {
  async function bindings() {
    input.assertCurrent()
    const description = await readProjectRuntimeDescription(input.root)
    input.assertCurrent()
    if (!description) return []
    if (description.status !== "ready") throw Error("PROJECT_ACTION_LOCK_MISMATCH")
    if (description.manifest.mode !== "host") return []
    const lock = readProjectActionLock(input.root, description.manifest)
    const values = new Map<string, ProjectFunctionDependencyReview>()
    for (const { ref } of lock.bindings) {
      const previous = values.get(ref.pluginId)
      if (previous && (previous.name !== ref.plugin || previous.digest !== ref.digest))
        throw Error("PROJECT_ACTION_LOCK_MISMATCH")
      if (previous) {
        if (!previous.actionIds.includes(ref.actionId)) previous.actionIds.push(ref.actionId)
      } else
        values.set(ref.pluginId, {
          pluginId: ref.pluginId,
          name: ref.plugin,
          digest: ref.digest,
          actionIds: [ref.actionId],
          state: "missing",
          capabilities: []
        })
    }
    input.assertCurrent()
    return [...values.values()]
  }

  async function resolve(pluginId: string) {
    const expected = (await bindings()).find((value) => value.pluginId === pluginId)
    if (!expected) throw Error("PROJECT_DEPENDENCY_NOT_DECLARED")
    const found = input.plugins().find((value) => value.id === pluginId)
    if (!found?.enabled) throw Error("PROJECT_DEPENDENCY_UNAVAILABLE")
    const plugin = { ...found }
    const identity = JSON.stringify(plugin)
    const assertIdentity = () => {
      input.assertCurrent()
      if (JSON.stringify(input.plugins().find((value) => value.id === pluginId)) !== identity)
        throw Error("PROJECT_DEPENDENCY_CHANGED")
    }
    const facts = await compileFunctionPlugin(plugin.path)
    assertIdentity()
    if (
      !facts ||
      facts.configurationOnly ||
      facts.name !== expected.name ||
      facts.digest !== expected.digest
    )
      throw Error("PROJECT_DEPENDENCY_CHANGED")
    const assertCurrent = () => {
      assertIdentity()
      // Approval legitimately invalidates the manager's compilation cache. Retain the original
      // compiler-issued byte proof, not the cache entry or any execution/session authority.
      assertConfigurationSourcesCurrent(plugin.path, facts)
      assertIdentity()
    }
    assertCurrent()
    return { plugin, expected, facts, assertCurrent }
  }

  async function review(): Promise<ProjectFunctionDependencyReview[]> {
    const declared = await bindings()
    if (!declared.length) return []
    const statuses = await input.manager.status(input.workspace)
    input.assertCurrent()
    for (const dependency of declared) {
      const installed = input.plugins().find((value) => value.id === dependency.pluginId)
      if (!installed) continue
      if (!installed.enabled) {
        dependency.state = "disabled"
        continue
      }
      const status = statuses.find((value) => value.pluginId === dependency.pluginId)
      if (!status || status.state === "invalid") {
        dependency.state = "invalid"
        continue
      }
      if (status.name !== dependency.name || status.digest !== dependency.digest) {
        dependency.state = "source-changed"
        continue
      }
      try {
        const resolved = await resolve(dependency.pluginId)
        await input.manager.prepareRuntimeSourceFacts({
          workspace: input.workspace,
          plugin: resolved.plugin
        })
        resolved.assertCurrent()
        dependency.capabilities = [...status.capabilities]
        dependency.hasConfiguration =
          !!resolved.facts.userConfig && Object.keys(resolved.facts.userConfig).length > 0
        dependency.configurationReady = true
        try {
          input.manager.assertRuntimeSourceConfiguration({
            workspace: input.workspace,
            plugin: resolved.plugin
          })
        } catch (error) {
          if (
            !(error instanceof ModFunctionError) ||
            !/^(MODS_USER_CONFIG_|MODS_SECRET_)/.test(error.code)
          )
            throw error
          dependency.configurationReady = false
        }
        // Grant is read last, after every asynchronous source read. Review never grants it.
        dependency.state = input.manager.isInstalledRuntimeSourceApproved({
          workspace: input.workspace,
          plugin: resolved.plugin,
          name: dependency.name,
          digest: dependency.digest
        }) ? "ready" : "needs-approval"
        resolved.assertCurrent()
      } catch {
        dependency.state = "source-changed"
      }
    }
    input.assertCurrent()
    return declared
  }
  return { review, resolve }
}
