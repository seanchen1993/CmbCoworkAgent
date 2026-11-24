export interface GitGraphRef {
  kind: "head" | "local" | "remote" | "tag"
  name: string
}

export interface GitGraphCommit {
  hash: string
  parents: string[]
  author: string
  timestamp: number
  subject: string
  refs: GitGraphRef[]
  /** For dense dialog pages, refs holds the preview. Blocks contain the remaining labels in Git order. */
  packedRefs?: { length: number; leading: number; blocks: string[] }
}

export interface GitGraphPage {
  commits: GitGraphCommit[]
  hasMore: boolean
  snapshot: string
  reset?: boolean
}

export const graphRefsPerBlock = 64

export function parseGitGraphRef(token: string): GitGraphRef | undefined {
  if (token.startsWith("refs/heads/")) return { kind: "local", name: token.slice(11) }
  if (token.startsWith("refs/remotes/")) return { kind: "remote", name: token.slice(13) }
  if (token.startsWith("tag: refs/tags/")) return { kind: "tag", name: token.slice(15) }
  return undefined
}

export function gitGraphRefAt(commit: GitGraphCommit, index: number): GitGraphRef {
  if (!commit.packedRefs || index < commit.refs.length) return commit.refs[index]
  const offset = index - commit.packedRefs.leading
  const block = commit.packedRefs.blocks[Math.floor(offset / graphRefsPerBlock)]
  return parseGitGraphRef(block.split("\n")[offset % graphRefsPerBlock])!
}
