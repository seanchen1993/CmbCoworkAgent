import type { IpcMain } from "electron"
import { GENERAL_PURPOSE_SUBAGENT } from "deepagents"
import type { ExpertAgentEntry } from "../../shared/expert-agent-types"
import {
  BUILT_IN_AGENT_PROFILES,
  accessTierForPolicy,
  registerEnabledLibraryAgentsReader
} from "../agent/agent-registry"
import { LIBRARY_AGENT_PROFILES } from "../agent/library"
import { getEnabledExpertAgents, setEnabledExpertAgents } from "../storage"

/** Solo's own general-purpose subagent is not a registry profile but belongs
 * on the 专家团 page as an always-on built-in. Name/description come from the
 * canonical deepagents definition (the same one runtime.ts spreads into the
 * task tool), so upstream wording changes propagate here automatically. */
const GENERAL_PURPOSE_ENTRY: ExpertAgentEntry = {
  name: GENERAL_PURPOSE_SUBAGENT.name,
  description: GENERAL_PURPOSE_SUBAGENT.description,
  builtIn: true,
  enabled: true,
  access: "full"
}

export function registerExpertAgentsHandlers(ipcMain: IpcMain): void {
  // Make loadAgentProfiles see the user's enabled list from now on. The
  // reader re-reads the store on every registry load, so toggles apply to
  // the next agent run without a restart. Stale names (from a library
  // upgrade/downgrade) pass through untouched — the registry drops what it
  // doesn't know, and storage's contract is that stored names outlive
  // library changes.
  registerEnabledLibraryAgentsReader(getEnabledExpertAgents)

  ipcMain.handle("expertAgents:list", async (): Promise<ExpertAgentEntry[]> => {
    const enabled = new Set(getEnabledExpertAgents())
    const builtIns: ExpertAgentEntry[] = [
      ...BUILT_IN_AGENT_PROFILES.map((p) => ({
        name: p.name,
        description: p.description,
        builtIn: true,
        enabled: true,
        access: accessTierForPolicy(p.disallowedTools, p.shellAccess)
      })),
      GENERAL_PURPOSE_ENTRY
    ]
    const library: ExpertAgentEntry[] = LIBRARY_AGENT_PROFILES.map((p) => ({
      name: p.name,
      description: p.description,
      builtIn: false,
      enabled: enabled.has(p.name),
      access: accessTierForPolicy(p.disallowedTools, p.shellAccess)
    }))
    return [...builtIns, ...library]
  })

  ipcMain.handle(
    "expertAgents:setEnabled",
    async (_event, payload: { name: string; enabled: boolean }): Promise<string[]> => {
      const { name, enabled } = payload ?? {}
      const isLibraryName = LIBRARY_AGENT_PROFILES.some((p) => p.name === name)
      if (!isLibraryName) {
        // Built-ins (and unknown names) are not toggleable — return current state.
        return getEnabledExpertAgents()
      }
      // Read-modify-write on the UNFILTERED stored list: names that aren't in
      // the current library must survive a toggle (storage.ts contract —
      // "stored names may outlive a library upgrade").
      const current = new Set(getEnabledExpertAgents())
      if (enabled) current.add(name)
      else current.delete(name)
      const next = [...current]
      setEnabledExpertAgents(next)
      return next
    }
  )
}
