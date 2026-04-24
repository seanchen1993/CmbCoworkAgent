/**
 * Slash-command registry: the single source of truth for what `/` can invoke.
 *
 * Why it exists:
 *   Renderer never sends a SKILL.md path directly. It sends an opaque `id` that
 *   main looks up here, so a compromised renderer cannot point the agent at an
 *   arbitrary file by forging a path string.
 *
 * Current scope: only `kind: "skill"` is populated. The `kind` type slot for
 * "local"/"prompt"/"ui" is reserved for future /clear, /model, /hooks-like
 * commands; they just aren't listed yet.
 */
import * as path from "path"
import { listAllSkills } from "../ipc/skills"
import { getDisabledSkills } from "../storage"
import type { SkillMetadata } from "../types"
import type { RegisteredSlashSkill, SlashCommandId, SlashCommandListItem } from "./types"

/**
 * Build a deterministic id from {source, name}. Stable across:
 *   - enabled/disabled toggles (the enabled-skills copy directory doesn't factor in),
 *   - app restarts (no mtime/hash dependency),
 *   - path relocations within the same source tree.
 *
 * Not security-sensitive on its own — the path re-resolution via listAllSkills()
 * below is what actually gates access.
 */
function makeSkillId(source: "project" | "user" | "plugin", name: string): SlashCommandId {
  // Namespace with source so a user skill named "foo" and a builtin named "foo"
  // don't collide (listAllSkills dedupes by name, but the registry stays
  // defensive since plugin skills may shadow built-ins in the future).
  return `skill:${source}:${name}`
}

function toRegistered(meta: SkillMetadata): RegisteredSlashSkill {
  return {
    kind: "skill",
    id: makeSkillId(meta.source, meta.name),
    name: meta.name,
    description: meta.description || "",
    skillPath: meta.path,
    baseDir: path.dirname(meta.path),
    source: meta.source
  }
}

/**
 * Return the enabled, user-visible slash command list.
 * Popover & autocomplete consume this; disabled skills are filtered out here
 * (not on the renderer side) so the renderer can't flip its own filter off.
 */
export async function listSlashCommands(): Promise<SlashCommandListItem[]> {
  const [all, disabled] = await Promise.all([listAllSkills(), Promise.resolve(getDisabledSkills())])
  const disabledSet = new Set(disabled)
  const out: SlashCommandListItem[] = []
  for (const meta of all) {
    if (disabledSet.has(meta.name)) continue
    out.push({
      kind: "skill",
      id: makeSkillId(meta.source, meta.name),
      name: meta.name,
      description: meta.description || "",
      source: meta.source
    })
  }
  return out
}

/**
 * Resolve an id back to a registered skill, or null if:
 *   - the id doesn't match any enabled skill,
 *   - the skill was disabled between renderer-list and main-dispatch.
 *
 * Returns null rather than throwing so the caller can decide whether to:
 *   (a) abort the turn with a user-visible error (fresh invoke), or
 *   (b) silently drop the skill and continue (resume rehydrate).
 */
export async function lookupSlashSkill(id: SlashCommandId): Promise<RegisteredSlashSkill | null> {
  if (typeof id !== "string" || !id.startsWith("skill:")) return null
  // Re-query on every lookup: skill set can change mid-session (user adds,
  // uploads, deletes). The cost is one directory listing per invocation —
  // cheap compared to the model call that follows.
  const [all, disabled] = await Promise.all([listAllSkills(), Promise.resolve(getDisabledSkills())])
  const disabledSet = new Set(disabled)
  for (const meta of all) {
    if (disabledSet.has(meta.name)) continue
    if (makeSkillId(meta.source, meta.name) === id) {
      return toRegistered(meta)
    }
  }
  return null
}
