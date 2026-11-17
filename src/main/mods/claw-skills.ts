import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import type {
  ClawSourceEntry,
  ClawSourceReference,
  ClawSourceSelection
} from "../../shared/mods/claw"
import type { SkillLifecycleSource } from "../agent/skill-lifecycle/registry"
import { discoverSkills, MAX_SKILL_DISCOVERY_DEPTH } from "../skills/discovery"
import type { NativeSkillUsagePolicy } from "../plugins/native-skill-usage"

/** Injectable host sources; renderer values never supply filesystem roots. */
export interface ClawSkillCatalogAccess {
  sources: () => Promise<SkillLifecycleSource[]>
  currentSources: () => SkillLifecycleSource[]
  disabledDirs: () => string[]
}

interface RegisteredSkill {
  entry: ClawSourceEntry
  source: SkillLifecycleSource
  sourceId: string
  root: string
  realRoot: string
  document: string
  localDocumentFingerprint?: string
}

interface DisabledSkillRoot {
  lexical: string
  physical: string
}

interface LiveSkillSources {
  current: ReadonlyMap<string, SkillLifecycleSource>
  disabled: readonly DisabledSkillRoot[]
}

interface SkillPathFilterBatch {
  live: LiveSkillSources
  roots: Array<{ root: string; maxDepth: number }>
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

function regularDocumentFingerprint(document: string): string | undefined {
  const stat = lstatSync(document, { bigint: true })
  if (!stat.isFile() || stat.ino === 0n || stat.mtimeNs <= 0n || stat.ctimeNs <= 0n)
    return undefined
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
    ":"
  )
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

function readDisabledRoots(access: ClawSkillCatalogAccess): DisabledSkillRoot[] {
  return access.disabledDirs().map((root) => ({ lexical: key(root), physical: realKey(root) }))
}

function disabled(skill: RegisteredSkill, roots: readonly DisabledSkillRoot[]): boolean {
  return roots.some(
    (root) => within(skill.root, root.lexical) || within(skill.realRoot, root.physical)
  )
}

function readLiveSources(access: ClawSkillCatalogAccess): LiveSkillSources {
  const disabled = readDisabledRoots(access)
  const current = new Map<string, SkillLifecycleSource>()
  for (const source of access.currentSources()) {
    const id = sourceIdentity(source)
    if (!current.has(id)) current.set(id, source)
  }
  return { current, disabled }
}

function* physicalSkillRoots(sources: Iterable<SkillLifecycleSource>) {
  for (const source of sources) {
    yield {
      root: realKey(source.sourceDir),
      maxDepth: source.maxDepth ?? MAX_SKILL_DISCOVERY_DEPTH
    }
  }
}

async function catalog(
  access: ClawSkillCatalogAccess,
  observeLocalDocuments = false
): Promise<RegisteredSkill[]> {
  const found = new Map<string, RegisteredSkill>()
  const sources = await access.sources()
  // Keep owner metadata when a host root and a plugin source overlap.
  sources.sort((left, right) => Number(Boolean(right.pluginId)) - Number(Boolean(left.pluginId)))
  for (const source of sources) {
    const sourceId = sourceIdentity(source)
    for (const skill of await discoverSkills(source.sourceDir, source.maxDepth)) {
      const realRoot = realKey(skill.rootDir)
      if (found.has(realRoot)) continue
      const id = `skill:${hash(JSON.stringify([sourceId, skill.relativePath]))}`
      try {
        const document = skill.skillMdPath
        const before =
          observeLocalDocuments && !source.pluginId
            ? regularDocumentFingerprint(document)
            : undefined
        const digest = documentDigest(id, document, realRoot)
        const localDocumentFingerprint =
          before && regularDocumentFingerprint(document) === before ? before : undefined
        found.set(realRoot, {
          entry: {
            id,
            name: skill.name,
            digest,
            ...(source.pluginName ? { owner: source.pluginName } : {})
          },
          source,
          sourceId,
          root: key(skill.rootDir),
          realRoot,
          document,
          localDocumentFingerprint
        })
      } catch {
        // An unreadable or moving source is unavailable, never an empty authorized skill.
      }
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      right.root.length - left.root.length ||
      (left.root < right.root ? -1 : left.root > right.root ? 1 : 0)
  )
}

export async function listClawSkillSources(
  access?: ClawSkillCatalogAccess
): Promise<ClawSourceEntry[]> {
  const host = access ?? (await hostAccess())
  const skills = await catalog(host)
  const disabledRoots = skills.length ? readDisabledRoots(host) : []
  return skills.filter((skill) => !disabled(skill, disabledRoots)).map(({ entry }) => entry)
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
    private readonly sourceVisible?: (source: SkillLifecycleSource) => boolean,
    private readonly usagePolicy?: NativeSkillUsagePolicy
  ) {
    this.selected = new Set(selection.items.map(({ id }) => id))
    const registeredById = new Map(registered.map((skill) => [skill.entry.id, skill]))
    const live = selection.items.length ? readLiveSources(access) : undefined
    const allowed = selection.items.map((reference) => {
      const skill = registeredById.get(reference.id)
      if (!skill || skill.entry.digest !== reference.digest || skill.entry.name !== reference.name)
        throw Error(`CLAW_SKILL_SOURCE_CHANGED: ${reference.name}`)
      this.assertCurrent(skill, live, true)
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
    this.usagePolicy?.assertCurrent()
    if (!this.allowed.length) return
    const live = readLiveSources(this.access)
    for (const skill of this.allowed) this.assertCurrent(skill, live, true)
  }

  private assertCurrent(
    skill: RegisteredSkill,
    live: LiveSkillSources | undefined = undefined,
    allowFreshLocalDocument = false
  ): void {
    if (this.usagePolicy?.allowsSkill(skill.document) === false)
      throw Error(`CLAW_SKILL_USAGE_UNAVAILABLE: ${skill.entry.name}`)
    if (!this.selected.has(skill.entry.id))
      throw Error(`CLAW_SKILL_NOT_SELECTED: ${skill.entry.name}`)
    if (disabled(skill, live?.disabled ?? readDisabledRoots(this.access)))
      throw Error(`CLAW_SKILL_DISABLED: ${skill.entry.name}`)
    const currentSource = live
      ? live.current.get(skill.sourceId)
      : this.access.currentSources().find((source) => sourceIdentity(source) === skill.sourceId)
    if (!currentSource || this.sourceVisible?.(currentSource) === false)
      throw Error(`CLAW_SKILL_SOURCE_UNAVAILABLE: ${skill.entry.name}`)
    try {
      const root = realKey(skill.root)
      if (root !== skill.realRoot) throw Error("changed")
      // Only automatic standalone discovery can use an unchanged regular-file generation.
      // Explicit references, selected Claws, plugin documents and link targets retain full reads.
      if (
        allowFreshLocalDocument &&
        skill.localDocumentFingerprint &&
        regularDocumentFingerprint(skill.document) === skill.localDocumentFingerprint
      )
        return
      if (documentDigest(skill.entry.id, skill.document, root) !== skill.entry.digest)
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
    return this.isPathHiddenCurrent(filePath, options.traverse === true)
  }

  /** Observe registered sources once for a synchronous tool result list. */
  filterVisiblePaths<T>(
    items: T[],
    pathOf: (item: T) => string,
    options: { traverse?: boolean } = {}
  ): T[] {
    let batch: SkillPathFilterBatch | undefined
    const readBatch = (): SkillPathFilterBatch => {
      if (!batch) {
        const live = readLiveSources(this.access)
        batch = { live, roots: Array.from(physicalSkillRoots(live.current.values())) }
      }
      return batch
    }
    return items.filter((item) =>
      !this.isPathHiddenCurrent(pathOf(item), options.traverse === true, readBatch)
    )
  }

  private isPathHiddenCurrent(
    filePath: string,
    traverse: boolean,
    readBatch?: () => SkillPathFilterBatch
  ): boolean {
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
          traverse &&
          this.registered.some(
            (skill) =>
              this.selected.has(skill.entry.id) &&
              (within(skill.root, candidate) || within(skill.realRoot, candidate)) &&
              skill.entry.id !== match.entry.id
          )
        )
          continue
        try {
          this.assertCurrent(match, readBatch?.().live)
        } catch {
          return true
        }
      }
      // Newly registered descendants during this runtime are never implicitly selected.
      const roots = readBatch?.().roots ?? physicalSkillRoots(this.access.currentSources())
      for (const { root, maxDepth } of roots) {
        if (!within(candidate, root)) continue
        let ancestor = candidate
        try {
          if (!statSync(candidate).isDirectory()) ancestor = dirname(candidate)
        } catch {
          ancestor = dirname(candidate)
        }
        while (within(ancestor, root)) {
          const depth = relative(root, ancestor).split(/[\\/]/).filter(Boolean).length
          if (depth <= maxDepth && existsSync(join(ancestor, "SKILL.md"))) {
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
  sourceVisible?: (source: SkillLifecycleSource) => boolean,
  usagePolicy?: NativeSkillUsagePolicy
): Promise<ClawSkillPolicy | undefined> {
  if ((!selection || selection.mode === "all") && !usagePolicy) return undefined
  const host = access ?? (await hostAccess())
  const pinsDocuments = selection?.mode === "selected"
  const registered = await catalog(host, !pinsDocuments && usagePolicy?.usage === "chat")
  const disabledRoots = !pinsDocuments && registered.length ? readDisabledRoots(host) : []
  const effective = pinsDocuments
    ? selection
    : {
        mode: "selected" as const,
        items: registered
          .filter(
            (skill) =>
              !disabled(skill, disabledRoots) &&
              usagePolicy?.allowsSkill(skill.document) !== false &&
              sourceVisible?.(skill.source) !== false
          )
          .map((skill) => skill.entry)
      }
  return new ClawSkillPolicy(registered, effective, host, sourceVisible, usagePolicy)
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
