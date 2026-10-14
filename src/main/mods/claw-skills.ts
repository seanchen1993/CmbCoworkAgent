import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type {
  ClawSourceEntry,
  ClawSourceReference,
  ClawSourceSelection
} from "../../shared/mods/claw"
import type { SkillLifecycleSource } from "../agent/skill-lifecycle/registry"
import { discoverSkills, MAX_SKILL_DISCOVERY_DEPTH } from "../skills/discovery"

/** Injectable host sources; renderer values never supply filesystem roots. */
export interface ClawSkillCatalogAccess {
  sources: () => Promise<SkillLifecycleSource[]>
  currentSources: () => SkillLifecycleSource[]
  disabledDirs: () => string[]
}

interface RegisteredSkill {
  entry: ClawSourceEntry
  source: SkillLifecycleSource
  root: string
  realRoot: string
  document: string
}

const key = (value: string): string => {
  const normalized = resolve(value).replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
const within = (value: string, root: string): boolean =>
  value === root || value.startsWith(`${root}/`)
const hash = (value: string): string => createHash("sha256").update(value).digest("hex")

/** Resolve aliases even for a not-yet-existing descendant. Never cache across operations. */
function realKey(value: string): string {
  let ancestor = resolve(value)
  for (;;) {
    try {
      return key(join(realpathSync.native(ancestor), relative(ancestor, resolve(value))))
    } catch {
      const parent = dirname(ancestor)
      if (parent === ancestor) return key(value)
      ancestor = parent
    }
  }
}

function sourceIdentity(source: SkillLifecycleSource): string {
  return JSON.stringify([
    source.pluginId ?? "local",
    key(source.sourceDir),
    source.maxDepth ?? MAX_SKILL_DISCOVERY_DEPTH,
    source.pluginRoot ? key(source.pluginRoot) : null
  ])
}

function documentDigest(id: string, document: string, realRoot: string): string {
  if (statSync(document).size > 2 * 1024 * 1024) throw Error("CLAW_SKILL_DOCUMENT_TOO_LARGE")
  return hash(JSON.stringify([id, realRoot, realKey(document), readFileSync(document, "utf8")]))
}

async function hostAccess(): Promise<ClawSkillCatalogAccess> {
  const storage = await import("../storage")
  return {
    sources: async () => [
      ...(await storage.getEnabledSkillsSources()).map((sourceDir) => ({ sourceDir })),
      ...storage.getEnabledPluginSkillSourceMetadata()
    ],
    currentSources: () => [
      ...storage.getSkillsSources().map((sourceDir) => ({ sourceDir })),
      ...storage.getEnabledPluginSkillSourceMetadata()
    ],
    disabledDirs: () => storage.getDisabledSkillDirs()
  }
}

function disabled(skill: RegisteredSkill, access: ClawSkillCatalogAccess): boolean {
  return access
    .disabledDirs()
    .some((root) => within(key(skill.root), key(root)) || within(skill.realRoot, realKey(root)))
}

async function catalog(access: ClawSkillCatalogAccess): Promise<RegisteredSkill[]> {
  const found = new Map<string, RegisteredSkill>()
  const sources = await access.sources()
  // Keep owner metadata when a host root and a plugin source overlap.
  sources.sort((left, right) => Number(Boolean(right.pluginId)) - Number(Boolean(left.pluginId)))
  for (const source of sources) {
    for (const skill of await discoverSkills(source.sourceDir, source.maxDepth)) {
      const realRoot = realKey(skill.rootDir)
      if (found.has(realRoot)) continue
      const id = `skill:${hash(JSON.stringify([sourceIdentity(source), skill.relativePath]))}`
      try {
        found.set(realRoot, {
          entry: {
            id,
            name: skill.name,
            digest: documentDigest(id, skill.skillMdPath, realRoot),
            ...(source.pluginName ? { owner: source.pluginName } : {})
          },
          source,
          root: key(skill.rootDir),
          realRoot,
          document: skill.skillMdPath
        })
      } catch {
        // An unreadable or moving source is unavailable, never an empty authorized skill.
      }
    }
  }
  return [...found.values()].sort((left, right) => right.root.length - left.root.length)
}

export async function listClawSkillSources(
  access?: ClawSkillCatalogAccess
): Promise<ClawSourceEntry[]> {
  const host = access ?? (await hostAccess())
  return (await catalog(host)).filter((skill) => !disabled(skill, host)).map(({ entry }) => entry)
}

export class ClawSkillPolicy {
  readonly lifecycleSources: SkillLifecycleSource[]
  readonly middlewareSources: string[]
  readonly skillPaths: string[]
  private readonly allowed: RegisteredSkill[]
  private readonly selected: Set<string>

  constructor(
    private readonly registered: RegisteredSkill[],
    selection: ClawSourceSelection,
    private readonly access: ClawSkillCatalogAccess,
    private readonly sourceVisible?: (source: SkillLifecycleSource) => boolean
  ) {
    this.selected = new Set(selection.items.map(({ id }) => id))
    const allowed = selection.items.map((reference) => {
      const skill = registered.find(({ entry }) => entry.id === reference.id)
      if (!skill || skill.entry.digest !== reference.digest || skill.entry.name !== reference.name)
        throw Error(`CLAW_SKILL_SOURCE_CHANGED: ${reference.name}`)
      this.assertCurrent(skill)
      return skill
    })
    this.allowed = allowed
    this.lifecycleSources = allowed.map((skill) => ({
      ...skill.source,
      sourceDir: skill.realRoot,
      maxDepth: 0
    }))
    // Deepagents discovers one child level. The backend filters sibling docs and nested roots.
    this.middlewareSources = [...new Set(allowed.map((skill) => dirname(skill.root)))]
    this.skillPaths = allowed.map((skill) => skill.document)
  }

  /** Model boundaries validate selected identities without rescanning the whole registry per file. */
  assertAllCurrent(): void {
    for (const skill of this.allowed) this.assertCurrent(skill)
  }

  private assertCurrent(skill: RegisteredSkill): void {
    if (!this.selected.has(skill.entry.id))
      throw Error(`CLAW_SKILL_NOT_SELECTED: ${skill.entry.name}`)
    if (disabled(skill, this.access)) throw Error(`CLAW_SKILL_DISABLED: ${skill.entry.name}`)
    const currentSource = this.access
      .currentSources()
      .find((source) => sourceIdentity(source) === sourceIdentity(skill.source))
    if (!currentSource || this.sourceVisible?.(currentSource) === false)
      throw Error(`CLAW_SKILL_SOURCE_UNAVAILABLE: ${skill.entry.name}`)
    try {
      const root = realKey(skill.root)
      if (
        root !== skill.realRoot ||
        documentDigest(skill.entry.id, skill.document, root) !== skill.entry.digest
      )
        throw Error("changed")
    } catch {
      throw Error(`CLAW_SKILL_SOURCE_CHANGED: ${skill.entry.name}`)
    }
  }

  assertSkillReference(reference: { name: string; path: string }): void {
    const lexical = key(reference.path)
    const real = realKey(reference.path)
    const skill = this.registered.find(
      (item) =>
        lexical === item.root ||
        lexical === key(item.document) ||
        real === item.realRoot ||
        real === key(join(item.realRoot, "SKILL.md"))
    )
    if (!skill || reference.name !== skill.entry.name)
      throw Error(`CLAW_SKILL_NOT_SELECTED: ${reference.name}`)
    this.assertCurrent(skill)
  }

  /** Applies only to registered skill roots, not to arbitrary workspace files or shell commands. */
  isPathHidden(filePath: string, options: { traverse?: boolean } = {}): boolean {
    for (const candidate of new Set([key(filePath), realKey(filePath)])) {
      const matches = this.registered
        .filter((skill) => within(candidate, skill.root) || within(candidate, skill.realRoot))
        .sort(
          (left, right) =>
            Math.max(right.root.length, right.realRoot.length) -
            Math.max(left.root.length, left.realRoot.length)
        )
      const match = matches[0]
      if (match) {
        if (
          options.traverse &&
          this.registered.some(
            (skill) =>
              this.selected.has(skill.entry.id) &&
              (within(skill.root, candidate) || within(skill.realRoot, candidate)) &&
              skill.entry.id !== match.entry.id
          )
        )
          continue
        try {
          this.assertCurrent(match)
        } catch {
          return true
        }
      }
      // Newly registered descendants during this runtime are never implicitly selected.
      for (const source of this.access.currentSources()) {
        const root = realKey(source.sourceDir)
        if (!within(candidate, root)) continue
        let ancestor = candidate
        try {
          if (!statSync(candidate).isDirectory()) ancestor = dirname(candidate)
        } catch {
          ancestor = dirname(candidate)
        }
        while (within(ancestor, root)) {
          const depth = relative(root, ancestor).split(/[\\/]/).filter(Boolean).length
          if (
            depth <= (source.maxDepth ?? MAX_SKILL_DISCOVERY_DEPTH) &&
            existsSync(join(ancestor, "SKILL.md"))
          ) {
            const canonicalAncestor = realKey(ancestor)
            const known = this.registered.find((skill) => skill.realRoot === canonicalAncestor)
            if (!known) return true
            break
          }
          if (ancestor === root) break
          ancestor = dirname(ancestor)
        }
      }
    }
    return false
  }
}

export async function createClawSkillPolicy(
  selection?: ClawSourceSelection,
  access?: ClawSkillCatalogAccess,
  sourceVisible?: (source: SkillLifecycleSource) => boolean
): Promise<ClawSkillPolicy | undefined> {
  if (!selection || selection.mode === "all") return undefined
  const host = access ?? (await hostAccess())
  return new ClawSkillPolicy(await catalog(host), selection, host, sourceVisible)
}

/** Host-only resolution: persisted flow nodes carry identity, never filesystem paths. */
export interface ResolvedFlowSkillSource {
  reference: ClawSourceReference
  trustedExplicitSkill: { name: string; path: string }
  assertCurrent(): void
}

export async function resolveFlowSkillSource(
  reference: ClawSourceReference,
  getSelection: () => ClawSourceSelection | undefined,
  access?: ClawSkillCatalogAccess
): Promise<ResolvedFlowSkillSource> {
  return (await createFlowSkillSourceResolver(getSelection, access))(reference)
}

/** One preparation snapshot for all nodes; live checks below never trust that snapshot alone. */
export async function createFlowSkillSourceResolver(
  getSelection: () => ClawSourceSelection | undefined,
  access?: ClawSkillCatalogAccess
): Promise<(reference: ClawSourceReference) => ResolvedFlowSkillSource> {
  const host = access ?? (await hostAccess())
  const registered = await catalog(host)
  return (reference) => resolveRegisteredFlowSkillSource(reference, getSelection, host, registered)
}

function resolveRegisteredFlowSkillSource(
  reference: ClawSourceReference,
  getSelection: () => ClawSourceSelection | undefined,
  host: ClawSkillCatalogAccess,
  registered: RegisteredSkill[]
): ResolvedFlowSkillSource {
  const pinned = { id: reference.id, name: reference.name, digest: reference.digest }
  // Even an unrestricted Claw must pin the explicitly chosen node's source.
  const pin = new ClawSkillPolicy(registered, { mode: "selected", items: [pinned] }, host)
  const skill = registered.find(({ entry }) => entry.id === pinned.id)!
  const assertCurrent = () => {
    const selection = getSelection()
    if (
      selection?.mode === "selected" &&
      !selection.items.some(
        (item) =>
          item.id === pinned.id && item.name === pinned.name && item.digest === pinned.digest
      )
    )
      throw Error(`CLAW_SKILL_NOT_SELECTED: ${pinned.name}`)
    pin.assertAllCurrent()
  }
  assertCurrent()
  return {
    reference: pinned,
    trustedExplicitSkill: { name: pinned.name, path: skill.document },
    assertCurrent
  }
}
