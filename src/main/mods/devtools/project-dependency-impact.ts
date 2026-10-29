import { readRuntimeScopedFileAsync } from "../../harness-board/project-runtime/safe-files-async"
import { nativeCompositionSchema } from "../../plugins/native-composition"
import { nativeCompositionActionRequirements } from "../../plugins/native-composition-dependencies"
import { parseProjectActionLock, PROJECT_ACTION_LOCK_PATH } from "../../../shared/project-runtime/action-bindings"
import type { AuthoringSourceBundle } from "./authoring-bundle"
import type { DevelopmentDependencyImpact } from "../../../shared/mods/development"

export interface DependencyImpactSource {
  id: string
  name: string
  kind: "installed" | "candidate"
  enabled?: boolean
  archived?: boolean
  source?: AuthoringSourceBundle
  directory?: string
}

const impactDisplayName = (value: string) => value.length <= 100 ? value : `${value.slice(0, 99)}…`

export function summarizeProjectDependencyImpact(
  report: Awaited<ReturnType<typeof projectDependencyImpact>>
): DevelopmentDependencyImpact {
  return { inspectedSources: report.inspectedSources,
    knownDependants: report.dependants.map(item => ({ id: item.id, name: impactDisplayName(item.name),
      kind: item.kind, actionIds: [...new Set(item.references.map(ref => ref.actionId))] })),
    uninspectedSources: new Set(report.uninspected.map(item => `${item.kind}:${item.id}`)).size,
    moreSources: report.nextCursor !== null, complete: false }
}

/** Exact declarative references only. Never evaluates scripts, grants access or rewrites dependants. */
export async function projectDependencyImpact(input: {
  plugin: string
  pluginId?: string
  sources: DependencyImpactSource[]
  cursor?: number
  assertCurrent(): void
}) {
  // Provider identity follows the existing Function loader, not authoring draft-id syntax.
  if (typeof input.plugin !== "string" || !/^[a-zA-Z0-9][\w.-]{0,99}$/.test(input.plugin))
    throw Error("DEVELOPMENT_INPUT")
  const cursor = input.cursor ?? 0
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > input.sources.length)
    throw Error("DEVELOPMENT_CATALOG_CURSOR")
  const sources = input.sources.slice(cursor, cursor + 16)
  const dependants: Array<{ id: string; name: string; kind: DependencyImpactSource["kind"];
    enabled?: boolean; archived?: boolean;
    references: Array<{ actionId: string; usedBy: string; digest?: string; pluginId?: string;
      identityPinned: boolean }> }> = []
  const uninspected: Array<{ id: string; kind: DependencyImpactSource["kind"]; reason: string }> = []
  for (const item of sources) {
    input.assertCurrent()
    const references: Array<{ actionId: string; usedBy: string; digest?: string; pluginId?: string;
      identityPinned: boolean }> = []
    for (const path of ["composition/source.json", PROJECT_ACTION_LOCK_PATH]) {
      let text = item.source?.files.find(file => file.path === path)?.text
      try {
        if (text === undefined && item.directory) {
          const file = await readRuntimeScopedFileAsync(item.directory, path, 128 * 1024)
          input.assertCurrent()
          text = file.bytes?.toString("utf8")
        }
        if (text === undefined) continue
        if (path === PROJECT_ACTION_LOCK_PATH) {
          for (const binding of parseProjectActionLock(JSON.parse(text)).bindings) {
            if (binding.ref.plugin !== input.plugin &&
              (!input.pluginId || binding.ref.pluginId !== input.pluginId)) continue
            const previous = references.findIndex(ref => ref.usedBy === binding.id)
            if (previous >= 0) references.splice(previous, 1)
            references.push({ actionId: binding.ref.actionId, usedBy: binding.id,
              pluginId: binding.ref.pluginId, digest: binding.ref.digest, identityPinned: true })
          }
        } else {
          for (const requirement of nativeCompositionActionRequirements(
            nativeCompositionSchema.parse(JSON.parse(text)))) {
            if (requirement.plugin !== input.plugin) continue
            if (!references.some(ref => ref.usedBy === requirement.usedBy))
              references.push({ actionId: requirement.actionId, usedBy: requirement.usedBy,
                identityPinned: false })
          }
        }
      } catch {
        input.assertCurrent()
        uninspected.push({ id: item.id, kind: item.kind, reason: "declaration-unreadable-or-invalid" })
      }
    }
    if (references.length) dependants.push({ id: item.id, name: impactDisplayName(item.name), kind: item.kind,
      ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
      ...(item.archived === undefined ? {} : { archived: item.archived }), references })
  }
  input.assertCurrent()
  return { provider: { plugin: input.plugin, ...(input.pluginId ? { pluginId: input.pluginId } : {}) },
    dependants, uninspected, inspectedSources: sources.length,
    nextCursor: cursor + 16 < input.sources.length ? cursor + 16 : null,
    scope: "Installed plugin declarations and source candidates in this creator chat only.",
    complete: false,
    limitation: "Dynamic JavaScript capability lookups, other creator chats, external copies and already bound project versions are not a complete dependency graph. No matching declaration does not prove no impact.",
    recommendation: "Identity-pinned callers keep requiring their original digest. A new provider version is not silently compatible: recompile/rebind and verify every affected caller before replacing it; review uninspected sources separately.",
    executed: false, grantsAuthority: false }
}
