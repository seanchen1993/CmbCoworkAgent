import { getRightPanelSkillPathSegments } from "@/components/panels/skill-tree-path"
import { isSkillDisabled, normalizeSkillId } from "@/lib/skill-ids"
import type { SkillMetadata } from "@/types"

export interface RightPanelSkillTreeNode {
  key: string
  label: string
  title?: string
  skill?: SkillMetadata
  children: RightPanelSkillTreeNode[]
  skillCount: number
}

export interface RightPanelSkillGroupProjection {
  skills: SkillMetadata[]
  tree: RightPanelSkillTreeNode[]
}

export interface RightPanelSkillProjection {
  enabled: SkillMetadata[]
  disabled: SkillMetadata[]
  enabledGeneral: RightPanelSkillGroupProjection
  enabledProgramming: RightPanelSkillGroupProjection
  disabledGeneral: RightPanelSkillGroupProjection
  disabledProgramming: RightPanelSkillGroupProjection
}

const PROGRAMMING_SKILL_IDS = new Set([
  "security-review",
  "code-review-expert",
  "vercel-react-best-practices",
  "audit-website",
  "supabase-postgres-best-practices",
  "typescript-advanced-types",
  "api-design-principles",
  "architecture-patterns",
  "error-handling-patterns",
  "planning-with-files",
  "mcp-builder",
  "webapp-testing",
  "frontend-design"
])

const projectionCache = new WeakMap<
  SkillMetadata[],
  WeakMap<Set<string>, RightPanelSkillProjection>
>()
const projectionPromiseCache = new WeakMap<
  SkillMetadata[],
  WeakMap<Set<string>, Promise<RightPanelSkillProjection>>
>()
let projectionBuildCount = 0

// A 20k catalog takes roughly 100-150ms when built synchronously. Processing
// about 1k nodes per turn keeps each slice below a frame on ordinary hardware
// without stretching the cooperative build across many seconds on Windows.
const PROJECTION_WORK_CHUNK = 1024

function yieldProjectionWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function compareSkillTreeNodes(a: RightPanelSkillTreeNode, b: RightPanelSkillTreeNode): number {
  const labelA = a.skill?.name || a.label
  const labelB = b.skill?.name || b.label
  return labelA.localeCompare(labelB, "zh-CN")
}

async function mergeSortedSkillTreeRuns(
  left: RightPanelSkillTreeNode[],
  right: RightPanelSkillTreeNode[]
): Promise<RightPanelSkillTreeNode[]> {
  const merged: RightPanelSkillTreeNode[] = []
  let leftIndex = 0
  let rightIndex = 0
  let workCount = 0

  while (leftIndex < left.length && rightIndex < right.length) {
    if (compareSkillTreeNodes(left[leftIndex], right[rightIndex]) <= 0) {
      merged.push(left[leftIndex])
      leftIndex += 1
    } else {
      merged.push(right[rightIndex])
      rightIndex += 1
    }
    workCount += 1
    if (workCount >= PROJECTION_WORK_CHUNK) {
      workCount = 0
      await yieldProjectionWork()
    }
  }

  merged.push(...left.slice(leftIndex), ...right.slice(rightIndex))
  return merged
}

async function sortSkillTreeNodesCooperatively(
  nodes: RightPanelSkillTreeNode[]
): Promise<RightPanelSkillTreeNode[]> {
  if (nodes.length <= PROJECTION_WORK_CHUNK) {
    return [...nodes].sort(compareSkillTreeNodes)
  }

  let runs: RightPanelSkillTreeNode[][] = []
  for (let index = 0; index < nodes.length; index += PROJECTION_WORK_CHUNK) {
    runs.push(nodes.slice(index, index + PROJECTION_WORK_CHUNK).sort(compareSkillTreeNodes))
    await yieldProjectionWork()
  }

  while (runs.length > 1) {
    const mergedRuns: RightPanelSkillTreeNode[][] = []
    for (let index = 0; index < runs.length; index += 2) {
      const right = runs[index + 1]
      mergedRuns.push(right ? await mergeSortedSkillTreeRuns(runs[index], right) : runs[index])
    }
    runs = mergedRuns
  }
  return runs[0] ?? []
}

function buildSkillTree(skills: SkillMetadata[]): RightPanelSkillTreeNode[] {
  const root: RightPanelSkillTreeNode = {
    key: "root",
    label: "root",
    children: [],
    skillCount: 0
  }
  const indexByNode = new WeakMap<RightPanelSkillTreeNode, Map<string, RightPanelSkillTreeNode>>()

  const getIndex = (node: RightPanelSkillTreeNode): Map<string, RightPanelSkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [child.key, child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (const skill of skills) {
    const segments = getRightPanelSkillPathSegments(skill)
    const fallbackSegments =
      segments.length > 0 ? segments : [{ key: skill.name, label: skill.name }]
    let current = root

    for (const segment of fallbackSegments) {
      const normalized = normalizeSkillId(segment.key || segment.label)
      const childIndex = getIndex(current)
      const nodeKey = `${current.key}/${normalized}`
      let child = childIndex.get(nodeKey)
      if (!child) {
        child = {
          key: nodeKey,
          label: segment.label,
          title: segment.title,
          children: [],
          skillCount: 0
        }
        current.children.push(child)
        childIndex.set(nodeKey, child)
      }
      current = child
    }

    current.skill = skill
  }

  const finalize = (nodes: RightPanelSkillTreeNode[]): RightPanelSkillTreeNode[] =>
    [...nodes]
      .sort((a, b) => {
        const labelA = a.skill?.name || a.label
        const labelB = b.skill?.name || b.label
        return labelA.localeCompare(labelB, "zh-CN")
      })
      .map((node) => {
        const children = finalize(node.children)
        return {
          ...node,
          children,
          skillCount:
            (node.skill ? 1 : 0) + children.reduce((sum, child) => sum + child.skillCount, 0)
        }
      })

  return finalize(root.children)
}

async function buildSkillTreeCooperatively(
  skills: SkillMetadata[]
): Promise<RightPanelSkillTreeNode[]> {
  const root: RightPanelSkillTreeNode = {
    key: "root",
    label: "root",
    children: [],
    skillCount: 0
  }
  const indexByNode = new WeakMap<RightPanelSkillTreeNode, Map<string, RightPanelSkillTreeNode>>()

  const getIndex = (node: RightPanelSkillTreeNode): Map<string, RightPanelSkillTreeNode> => {
    let index = indexByNode.get(node)
    if (!index) {
      index = new Map(node.children.map((child) => [child.key, child]))
      indexByNode.set(node, index)
    }
    return index
  }

  for (let skillIndex = 0; skillIndex < skills.length; skillIndex += 1) {
    const skill = skills[skillIndex]
    const segments = getRightPanelSkillPathSegments(skill)
    const fallbackSegments =
      segments.length > 0 ? segments : [{ key: skill.name, label: skill.name }]
    let current = root

    for (const segment of fallbackSegments) {
      const normalized = normalizeSkillId(segment.key || segment.label)
      const childIndex = getIndex(current)
      const nodeKey = `${current.key}/${normalized}`
      let child = childIndex.get(nodeKey)
      if (!child) {
        child = {
          key: nodeKey,
          label: segment.label,
          title: segment.title,
          children: [],
          skillCount: 0
        }
        current.children.push(child)
        childIndex.set(nodeKey, child)
      }
      current = child
    }
    current.skill = skill

    if ((skillIndex + 1) % PROJECTION_WORK_CHUNK === 0) {
      await yieldProjectionWork()
    }
  }

  let finalizedNodeCount = 0
  const finalize = async (nodes: RightPanelSkillTreeNode[]): Promise<RightPanelSkillTreeNode[]> => {
    const finalized: RightPanelSkillTreeNode[] = []
    for (const node of nodes) {
      const children = await finalize(node.children)
      finalized.push({
        ...node,
        children,
        skillCount:
          (node.skill ? 1 : 0) + children.reduce((sum, child) => sum + child.skillCount, 0)
      })
      finalizedNodeCount += 1
      if (finalizedNodeCount % PROJECTION_WORK_CHUNK === 0) {
        await yieldProjectionWork()
      }
    }
    return sortSkillTreeNodesCooperatively(finalized)
  }

  return finalize(root.children)
}

function isProgrammingSkill(skill: SkillMetadata): boolean {
  return PROGRAMMING_SKILL_IDS.has(skill.name.trim().toLowerCase())
}

function createGroup(skills: SkillMetadata[]): RightPanelSkillGroupProjection {
  return { skills, tree: buildSkillTree(skills) }
}

async function createGroupCooperatively(
  skills: SkillMetadata[]
): Promise<RightPanelSkillGroupProjection> {
  return { skills, tree: await buildSkillTreeCooperatively(skills) }
}

function getCachedProjection(
  skills: SkillMetadata[],
  disabledSkillIds: Set<string>
): RightPanelSkillProjection | undefined {
  return projectionCache.get(skills)?.get(disabledSkillIds)
}

function cacheProjection(
  skills: SkillMetadata[],
  disabledSkillIds: Set<string>,
  projection: RightPanelSkillProjection
): void {
  let byDisabledSet = projectionCache.get(skills)
  if (!byDisabledSet) {
    byDisabledSet = new WeakMap()
    projectionCache.set(skills, byDisabledSet)
  }
  byDisabledSet.set(disabledSkillIds, projection)
}

/**
 * The RightPanel rerenders for streaming state. Cache its directory projection
 * by the application catalog's stable array/set identities, not by a component
 * instance, so remounts and stream ticks stay O(1).
 */
export function getRightPanelSkillProjection(
  skills: SkillMetadata[],
  disabledSkillIds: Set<string>
): RightPanelSkillProjection {
  const cached = getCachedProjection(skills, disabledSkillIds)
  if (cached) return cached

  const enabled: SkillMetadata[] = []
  const disabled: SkillMetadata[] = []
  for (const skill of skills) {
    if (isSkillDisabled(skill, disabledSkillIds)) disabled.push(skill)
    else enabled.push(skill)
  }

  const projection: RightPanelSkillProjection = {
    enabled,
    disabled,
    enabledGeneral: createGroup(enabled.filter((skill) => !isProgrammingSkill(skill))),
    enabledProgramming: createGroup(enabled.filter(isProgrammingSkill)),
    disabledGeneral: createGroup(disabled.filter((skill) => !isProgrammingSkill(skill))),
    disabledProgramming: createGroup(disabled.filter(isProgrammingSkill))
  }
  projectionBuildCount += 1
  cacheProjection(skills, disabledSkillIds, projection)
  return projection
}

/**
 * Builds a large skill directory without monopolizing the renderer event loop.
 * The promise is shared by stable catalog identities, so opening a second panel
 * or remounting while the first build is running does not duplicate the work.
 */
export function getRightPanelSkillProjectionAsync(
  skills: SkillMetadata[],
  disabledSkillIds: Set<string>
): Promise<RightPanelSkillProjection> {
  const cached = getCachedProjection(skills, disabledSkillIds)
  if (cached) return Promise.resolve(cached)

  let byDisabledSet = projectionPromiseCache.get(skills)
  if (!byDisabledSet) {
    byDisabledSet = new WeakMap()
    projectionPromiseCache.set(skills, byDisabledSet)
  }
  const pending = byDisabledSet.get(disabledSkillIds)
  if (pending) return pending

  const build = (async (): Promise<RightPanelSkillProjection> => {
    const enabled: SkillMetadata[] = []
    const disabled: SkillMetadata[] = []
    for (let index = 0; index < skills.length; index += 1) {
      const skill = skills[index]
      if (isSkillDisabled(skill, disabledSkillIds)) disabled.push(skill)
      else enabled.push(skill)
      if ((index + 1) % PROJECTION_WORK_CHUNK === 0) {
        await yieldProjectionWork()
      }
    }

    const enabledGeneral: SkillMetadata[] = []
    const enabledProgramming: SkillMetadata[] = []
    const disabledGeneral: SkillMetadata[] = []
    const disabledProgramming: SkillMetadata[] = []
    const partition = async (
      source: SkillMetadata[],
      general: SkillMetadata[],
      programming: SkillMetadata[]
    ): Promise<void> => {
      for (let index = 0; index < source.length; index += 1) {
        const skill = source[index]
        if (isProgrammingSkill(skill)) programming.push(skill)
        else general.push(skill)
        if ((index + 1) % PROJECTION_WORK_CHUNK === 0) {
          await yieldProjectionWork()
        }
      }
    }
    await partition(enabled, enabledGeneral, enabledProgramming)
    await partition(disabled, disabledGeneral, disabledProgramming)

    const projection: RightPanelSkillProjection = {
      enabled,
      disabled,
      enabledGeneral: await createGroupCooperatively(enabledGeneral),
      enabledProgramming: await createGroupCooperatively(enabledProgramming),
      disabledGeneral: await createGroupCooperatively(disabledGeneral),
      disabledProgramming: await createGroupCooperatively(disabledProgramming)
    }
    projectionBuildCount += 1
    cacheProjection(skills, disabledSkillIds, projection)
    return projection
  })()
  byDisabledSet.set(disabledSkillIds, build)
  return build
}

export function getRightPanelSkillProjectionDiagnostics(): { buildCount: number } {
  return { buildCount: projectionBuildCount }
}

export function resetRightPanelSkillProjectionDiagnosticsForTests(): void {
  projectionBuildCount = 0
}
