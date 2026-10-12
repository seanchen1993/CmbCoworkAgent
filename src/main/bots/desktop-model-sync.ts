import { readDesktopMcpSources } from "../mcp/desktop-sources"
import { runtimeTimezone } from "../agent/runtime-time-context"
import { getCmbCoworkAgentsHome } from "../agent/agents-md"
import { currentFailureFusePolicy } from "./failure-fuse-policy"
import {
  getAgentGraphRecursionLimit,
  getAgentToolStrategy,
  getWorkflowWorktreeTimeoutMinutes,
  getWorkflowWorktreeRemoveTimeoutMinutes
} from "../../shared/agent-runtime-limits"
import { desktopBotExecutionConfig } from "./desktop-execution-config"
import { desktopBotModsConfig } from "./desktop-mods-config"
import { desktopBotSkillSources } from "./desktop-skills-config"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"
import { getAvailableModelConfigOrDefault, getModelConfigs } from "../models/registry"
import { readBotModelSnapshot, writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import {
  botModelSnapshotGeneration,
  completeBotModelSnapshotGeneration
} from "./model-config-fence"

const previousHashes = new Map<string, string>()
let pending: Promise<void> = Promise.resolve()
export async function syncDesktopBotModels(directory: string): Promise<void> {
  // Every caller joins the tail before awaiting it. A group of callers released
  // by an earlier write must not all publish to the same snapshot concurrently.
  const task = pending
    .catch(() => {})
    .then(async () => {
      const path = join(directory, "models.private")
      const generation = botModelSnapshotGeneration(path)
      const skillSources = await desktopBotSkillSources()
      const snapshot: BotModelSnapshot = {
        version: 1,
        timezone: runtimeTimezone(),
        instructionSources: { agentsHome: getCmbCoworkAgentsHome() },
        graphRecursionLimit: getAgentGraphRecursionLimit(),
        failureFuse: currentFailureFusePolicy(),
        toolStrategy: getAgentToolStrategy(),
        workflowWorktreeTimeoutMinutes: getWorkflowWorktreeTimeoutMinutes(),
        workflowWorktreeRemoveTimeoutMinutes: getWorkflowWorktreeRemoveTimeoutMinutes(),
        skillSources,
        hookSources: skillSources ? { root: dirname(skillSources.pluginsStorePath) } : undefined,
        harnessSources: skillSources ? { root: dirname(skillSources.pluginsStorePath) } : undefined,
        mcpSources: readDesktopMcpSources(),
        execution: desktopBotExecutionConfig(),
        mods: desktopBotModsConfig(),
        defaultRef: getAvailableModelConfigOrDefault()?.ref ?? null,
        models: getModelConfigs().map((config) => ({ ...config }))
      }
      const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")
      if (hash !== previousHashes.get(directory) || !existsSync(path)) {
        let unchanged = false
        try {
          // A new desktop process has no in-memory hash. Compare the complete
          // persisted value, including credentials, before replacing a file that
          // active Host readers may already have open. JSON drops undefined fields.
          unchanged = isDeepStrictEqual(
            await readBotModelSnapshot(path),
            JSON.parse(JSON.stringify(snapshot))
          )
        } catch {
          // Missing, fenced or malformed snapshots must be rebuilt. Publication
          // still clears only the generation captured before reading settings.
        }
        if (!unchanged) await writeBotModelSnapshot(path, snapshot)
        previousHashes.set(directory, hash)
      }
      completeBotModelSnapshotGeneration(path, generation)
    })
  pending = task
  return task
}
