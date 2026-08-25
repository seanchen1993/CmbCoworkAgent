export interface WorkspaceFileTreeFile {
  path: string
  is_dir?: boolean
  size?: number
  modified_at?: string
}

export interface WorkspaceFileTreeNode {
  name: string
  path: string
  is_dir: boolean
  file?: WorkspaceFileTreeFile
  children: WorkspaceFileTreeNode[]
}

export interface WorkspaceFileTreeProjection {
  tree: WorkspaceFileTreeNode[]
  nodesByPath: Map<string, WorkspaceFileTreeNode>
  ordered: boolean
}

const projections = new WeakMap<WorkspaceFileTreeFile[], WorkspaceFileTreeProjection>()
const PROJECTION_TASK_ENTRY_BUDGET = 128
const SORT_RUN_SIZE = 256
const yieldResolvers: Array<() => void> = []
let yieldSequence = 0
const yieldChannel =
  typeof MessageChannel === "undefined"
    ? null
    : (() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => yieldResolvers.shift()?.()
        return channel
      })()

function yieldToRenderer(): Promise<void> {
  yieldSequence += 1
  // MessageChannel is low-latency, but an uninterrupted chain can starve
  // timers/input on some runtimes. Periodically enter the timer queue too.
  if (!yieldChannel || yieldSequence % 64 === 0) {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => {
    yieldResolvers.push(resolve)
    yieldChannel.port2.postMessage(0)
  })
}

function throwIfProjectionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Workspace file tree projection was cancelled")
  error.name = "AbortError"
  throw error
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

function compareNodes(left: WorkspaceFileTreeNode, right: WorkspaceFileTreeNode): number {
  if (left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1
  const localized = left.name.localeCompare(right.name)
  if (localized !== 0) return localized
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

export function createWorkspaceFileTreeProjectionBuilder(
  ordered: boolean
): WorkspaceFileTreeProjection {
  return { tree: [], nodesByPath: new Map(), ordered }
}

function upsertProjectionFile(
  projection: WorkspaceFileTreeProjection,
  file: WorkspaceFileTreeFile
): void {
  const normalizedPath = normalizePath(file.path)
  if (!normalizedPath) return
  const parts = normalizedPath.split("/")
  let parentChildren = projection.tree
  let currentPath = ""

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    currentPath = currentPath ? `${currentPath}/${part}` : part
    const isLeaf = index === parts.length - 1
    let node = projection.nodesByPath.get(currentPath)
    if (!node) {
      node = {
        name: part,
        path: `/${currentPath}`,
        is_dir: isLeaf ? file.is_dir === true : true,
        ...(isLeaf ? { file } : {}),
        children: []
      }
      projection.nodesByPath.set(currentPath, node)
      parentChildren.push(node)
    } else if (isLeaf) {
      node.is_dir = file.is_dir === true
      node.file = file
    }
    parentChildren = node.children
  }
}

export function appendWorkspaceFileTreeProjectionPage(
  projection: WorkspaceFileTreeProjection,
  files: readonly WorkspaceFileTreeFile[]
): void {
  // IPC guarantees the page's entry/byte budget. Keep projection work in the
  // same bounded task and let the next IPC round trip yield the event loop.
  for (const file of files) upsertProjectionFile(projection, file)
}

async function cooperativeSortNodes(
  input: WorkspaceFileTreeNode[],
  signal?: AbortSignal
): Promise<WorkspaceFileTreeNode[]> {
  throwIfProjectionAborted(signal)
  if (input.length <= SORT_RUN_SIZE) {
    input.sort(compareNodes)
    return input
  }
  let source = input.slice()
  for (let offset = 0; offset < source.length; offset += SORT_RUN_SIZE) {
    source
      .slice(offset, offset + SORT_RUN_SIZE)
      .sort(compareNodes)
      .forEach((node, index) => {
        source[offset + index] = node
      })
    await yieldToRenderer()
    throwIfProjectionAborted(signal)
  }
  for (let width = SORT_RUN_SIZE; width < source.length; width *= 2) {
    const target = new Array<WorkspaceFileTreeNode>(source.length)
    let operations = 0
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length)
      const end = Math.min(start + width * 2, source.length)
      let left = start
      let right = middle
      let output = start
      while (left < middle || right < end) {
        if (right >= end || (left < middle && compareNodes(source[left], source[right]) <= 0)) {
          target[output++] = source[left++]
        } else {
          target[output++] = source[right++]
        }
        operations += 1
        if (operations >= 512) {
          operations = 0
          await yieldToRenderer()
          throwIfProjectionAborted(signal)
        }
      }
    }
    source = target
  }
  return source
}

async function finalizeUnorderedProjection(
  projection: WorkspaceFileTreeProjection,
  signal?: AbortSignal
): Promise<void> {
  const directories: WorkspaceFileTreeNode[] = []
  let count = 0
  for (const node of projection.nodesByPath.values()) {
    if (node.is_dir) directories.push(node)
    count += 1
    if (count >= PROJECTION_TASK_ENTRY_BUDGET) {
      count = 0
      await yieldToRenderer()
      throwIfProjectionAborted(signal)
    }
  }
  projection.tree = await cooperativeSortNodes(projection.tree, signal)
  let directoriesSinceYield = 0
  let childEntriesSinceYield = 0
  for (const directory of directories) {
    if (directory.children.length > SORT_RUN_SIZE) {
      directory.children = await cooperativeSortNodes(directory.children, signal)
      directoriesSinceYield = 0
      childEntriesSinceYield = 0
      continue
    }
    directory.children.sort(compareNodes)
    directoriesSinceYield += 1
    childEntriesSinceYield += directory.children.length
    if (
      directoriesSinceYield >= PROJECTION_TASK_ENTRY_BUDGET ||
      childEntriesSinceYield >= SORT_RUN_SIZE * 2
    ) {
      directoriesSinceYield = 0
      childEntriesSinceYield = 0
      await yieldToRenderer()
      throwIfProjectionAborted(signal)
    }
  }
  projection.ordered = true
}

export async function finalizeWorkspaceFileTreeProjection(
  files: WorkspaceFileTreeFile[],
  projection: WorkspaceFileTreeProjection,
  signal?: AbortSignal
): Promise<WorkspaceFileTreeProjection> {
  throwIfProjectionAborted(signal)
  if (!projection.ordered) await finalizeUnorderedProjection(projection, signal)
  throwIfProjectionAborted(signal)
  projections.set(files, projection)
  return projection
}

export async function buildWorkspaceFileTreeProjection(
  files: WorkspaceFileTreeFile[],
  signal?: AbortSignal
): Promise<WorkspaceFileTreeProjection> {
  throwIfProjectionAborted(signal)
  const cached = projections.get(files)
  if (cached) return cached
  const projection = createWorkspaceFileTreeProjectionBuilder(false)
  for (let offset = 0; offset < files.length; offset += PROJECTION_TASK_ENTRY_BUDGET) {
    appendWorkspaceFileTreeProjectionPage(
      projection,
      files.slice(offset, offset + PROJECTION_TASK_ENTRY_BUDGET)
    )
    await yieldToRenderer()
    throwIfProjectionAborted(signal)
  }
  return finalizeWorkspaceFileTreeProjection(files, projection, signal)
}

export function getWorkspaceFileTreeProjection(
  files: WorkspaceFileTreeFile[]
): WorkspaceFileTreeProjection | undefined {
  return projections.get(files)
}

function findInsertIndex(
  nodes: readonly WorkspaceFileTreeNode[],
  candidate: WorkspaceFileTreeNode
): number {
  let low = 0
  let high = nodes.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareNodes(nodes[middle], candidate) <= 0) low = middle + 1
    else high = middle
  }
  return low
}

function findExistingNodeIndex(
  nodes: readonly WorkspaceFileTreeNode[],
  candidate: WorkspaceFileTreeNode
): number {
  let low = 0
  let high = nodes.length - 1
  while (low <= high) {
    const middle = (low + high) >>> 1
    const compared = compareNodes(nodes[middle], candidate)
    if (compared < 0) low = middle + 1
    else if (compared > 0) high = middle - 1
    else return nodes[middle] === candidate ? middle : -1
  }
  return -1
}

function removeProjectionPath(projection: WorkspaceFileTreeProjection, filePath: string): void {
  let normalizedPath = normalizePath(filePath)
  let node = projection.nodesByPath.get(normalizedPath)
  if (!node) return
  while (node) {
    const separator = normalizedPath.lastIndexOf("/")
    const parentPath = separator < 0 ? "" : normalizedPath.slice(0, separator)
    const siblings = parentPath
      ? projection.nodesByPath.get(parentPath)?.children
      : projection.tree
    const index = siblings ? findExistingNodeIndex(siblings, node) : -1
    if (siblings && index >= 0) siblings.splice(index, 1)
    projection.nodesByPath.delete(normalizedPath)
    if (!parentPath) break
    normalizedPath = parentPath
    node = projection.nodesByPath.get(parentPath)
    if (!node || node.file || node.children.length > 0) break
  }
}

export function patchWorkspaceFileTreeProjection(
  previousFiles: WorkspaceFileTreeFile[],
  nextFiles: WorkspaceFileTreeFile[],
  upserts: readonly WorkspaceFileTreeFile[],
  deletes: readonly string[]
): void {
  const projection = projections.get(previousFiles)
  if (!projection) return
  for (const filePath of deletes) removeProjectionPath(projection, filePath)
  for (const file of upserts) {
    const normalizedPath = normalizePath(file.path)
    const existing = projection.nodesByPath.get(normalizedPath)
    if (existing) {
      existing.file = file
      existing.is_dir = file.is_dir === true
      continue
    }
    upsertProjectionFile(projection, file)
    const inserted = projection.nodesByPath.get(normalizedPath)
    if (!inserted) continue
    const separator = normalizedPath.lastIndexOf("/")
    const parentPath = separator < 0 ? "" : normalizedPath.slice(0, separator)
    const siblings = parentPath ? projection.nodesByPath.get(parentPath)?.children : projection.tree
    if (!siblings) continue
    const appendedIndex = siblings[siblings.length - 1] === inserted ? siblings.length - 1 : -1
    if (appendedIndex >= 0) siblings.splice(appendedIndex, 1)
    siblings.splice(findInsertIndex(siblings, inserted), 0, inserted)
  }
  projections.set(nextFiles, projection)
}
