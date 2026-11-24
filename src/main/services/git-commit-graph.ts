import { createHash, type Hash } from "node:crypto"
import { lstat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { graphRefsPerBlock, parseGitGraphRef, type GitGraphCommit, type GitGraphPage, type GitGraphRef } from "../../shared/git-graph"

type ReadGit = (
  args: string[],
  input?: string,
  consume?: (chunk: Buffer) => void
) => Promise<string>

type GitGraphHead = string | { ref: Buffer; revision?: string }

const pageSize = 50
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function headRevision(head: GitGraphHead): string {
  return typeof head === "string" ? head : head.revision ?? ""
}

function headIdentity(head: GitGraphHead): string {
  return typeof head === "string" ? head : head.revision ?? `raw:${head.ref.toString("hex")}`
}

function headDecorationOffset(decorations: Buffer, ref: Buffer): number {
  for (let index = decorations.indexOf(ref); index !== -1; index = decorations.indexOf(ref, index + 1)) {
    const end = index + ref.length
    // Git separates tokens with ", " and " -> ". Spaces cannot occur in a ref.
    const startsToken = index === 0 || decorations[index - 1] === 32
    const endsToken = end === decorations.length || decorations[end] === 32 ||
      (decorations[end] === 44 && decorations[end + 1] === 32)
    if (startsToken && endsToken) return index
  }
  return -1
}

// Spaces are forbidden in refs, so the decoration separators and raw lines are unambiguous.
async function assignCommitRefs(
  commit: GitGraphCommit, raw: Buffer | undefined, head: GitGraphHead, forDialog: boolean, signal?: AbortSignal
): Promise<void> {
  const decorations = raw?.toString("utf8") ?? ""
  const offset = raw && typeof head !== "string" ? headDecorationOffset(raw, head.ref) : -1
  const attachedStart = raw && offset > 0 ? raw.toString("utf8", 0, offset).length : offset
  const pack = forDialog && decorations.length > 16 * 1024
  const separators = /, | -> /g
  const blocks: string[] = []
  const block: string[] = []
  let attached: GitGraphRef | undefined
  let count = 0
  let start = 0
  while (start < decorations.length) {
    const separator = separators.exec(decorations)
    const token = decorations.slice(start, separator?.index ?? decorations.length)
    const ref = parseGitGraphRef(token)
    if (ref?.kind === "local" && (typeof head === "string" ? token === head : start === attachedStart)) {
      attached = ref
    } else if (ref) {
      if (!pack || count < 4) commit.refs.push(ref)
      if (pack) {
        block.push(token)
        if (block.length === graphRefsPerBlock) {
          blocks.push(block.join("\n"))
          block.length = 0
        }
      }
      if (++count % 4096 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        signal?.throwIfAborted()
      }
    }
    if (!separator) break
    start = separators.lastIndex
  }
  const leading: GitGraphRef[] = []
  if (attached || head === commit.hash) leading.push({ kind: "head", name: "HEAD" })
  if (attached) leading.push(attached)
  commit.refs.unshift(...leading)
  if (pack) {
    if (block.length) blocks.push(block.join("\n"))
    commit.refs = commit.refs.slice(0, 4)
    commit.packedRefs = { length: count + leading.length, leading: leading.length, blocks }
  }
}

async function readHead(read: ReadGit): Promise<GitGraphHead> {
  try {
    const args = ["symbolic-ref", "--quiet", "HEAD"]
    const name = (await read(args)).replace(/\r?\n$/, "")
    if (name.startsWith("refs/heads/")) {
      if (!name.includes("\uFFFD")) return name
      // Git accepts ref names that cannot round-trip through a UTF-8 string.
      const chunks: Buffer[] = []
      const output = await read(args, undefined, (chunk) => chunks.push(chunk))
      const raw = chunks.length ? Buffer.concat(chunks) : Buffer.from(output)
      let end = raw.length
      if (raw[end - 1] === 10) end--
      if (raw[end - 1] === 13) end--
      const ref = raw.subarray(0, end)
      const decoded = ref.toString("utf8")
      if (decoded.startsWith("refs/heads/")) {
        return decoded.includes("\uFFFD")
          ? { ref, revision: Buffer.from(decoded).equals(ref) ? decoded : undefined }
          : decoded
      }
    }
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error
  }
  try {
    return (await read(["show-ref", "--head", "--verify", "--hash", "--", "HEAD"])).trim()
  } catch (error) {
    if ((error as { stderr?: string }).stderr?.trimEnd().endsWith("'HEAD' - not a valid ref"))
      return ""
    throw error
  }
}

async function readReplaceRefsConfig(read: ReadGit): Promise<boolean> {
  try {
    return (await read(["config", "--bool", "--get", "core.useReplaceRefs"])).trim() === "true"
  } catch (error) {
    if ((error as { code?: number }).code === 1) return true
    throw error
  }
}

async function hashOptionalGitFile(read: ReadGit, file: string, grafts = false): Promise<string> {
  try {
    return await read(["hash-object", "--no-filters", "--", file])
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? ""
    if (stderr.trimEnd().endsWith(": No such file or directory")) return ""
    // Git log ignores an unreadable optional grafts file. Let the history walk
    // handle it exactly as Git does, while keeping shallow boundary errors strict.
    if (grafts && (error as { code?: number }).code === 128) return ""
    throw error
  }
}

const pendingGraftStats = new Set<string>()

async function canSkipGraftsFile(path: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  // lstat itself cannot be cancelled. Leave libuv capacity for other work on a stalled volume.
  if (pendingGraftStats.has(path) || pendingGraftStats.size >= 2) return false
  pendingGraftStats.add(path)
  const unused = lstat(path)
    .then((stat) => stat.isDirectory(), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
    .finally(() => pendingGraftStats.delete(path))
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      unused,
      new Promise<boolean>((resolve, reject) => {
        abort = () => reject(signal?.reason)
        signal?.addEventListener("abort", abort, { once: true })
        // The filesystem probe is optional. Let Git handle stalled volumes.
        timer = setTimeout(resolve, 100, false)
        timer.unref()
      })
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener("abort", abort)
  }
}

async function hashGrafts(read: ReadGit, path: string, signal?: AbortSignal): Promise<string> {
  if (isAbsolute(path) && await canSkipGraftsFile(path, signal)) return ""
  return hashOptionalGitFile(read, path, true)
}

async function readHistoryBoundary(read: ReadGit, signal?: AbortSignal): Promise<string> {
  const replaceBase = process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/"
  const graftPathFormat = process.env.GIT_GRAFT_FILE === undefined ? ["--path-format=absolute"] : []
  const [replacements, state] = await Promise.all([
    replaceBase.endsWith("/")
      ? read(["for-each-ref", "--format=%(refname) %(objectname)", "--", replaceBase])
      : read(["replace", "--list", "--format=medium"]),
    read(["rev-parse", "--is-shallow-repository", ...graftPathFormat, "--git-path", "info/grafts"])
  ])
  const firstLine = state.indexOf("\n")
  const shallow = state.slice(0, firstLine).trim()
  // Old Git echoes the unknown rev-parse flag and then prints a relative path.
  const pathOutput = state.slice(firstLine + 1).replace(/\r?\n$/, "")
  const grafts = graftPathFormat.length ? pathOutput.replace(/^--path-format=absolute\r?\n/, "") : pathOutput
  let boundary = ""
  if (shallow === "true") {
    const path = (await read(["rev-parse", "--git-path", "shallow"])).replace(/\r?\n$/, "")
    boundary = await hashOptionalGitFile(read, path)
  }
  if (replacements) {
    boundary += `${await readReplaceRefsConfig(read)}\0${process.env.GIT_NO_REPLACE_OBJECTS !== undefined}\0`
    boundary += replacements
  }
  return boundary + "\0" + (await (graftPathFormat.length
    ? hashGrafts(read, grafts, signal)
    : hashOptionalGitFile(read, grafts, true)))
}

// Ref names cannot contain tabs or newlines. Git peels tags, ignores non-commit
// tags and determines tip order exactly as it does for the history walk.
const tipArgs = [
  "log",
  "--no-walk=unsorted",
  "--ignore-missing",
  "--no-color",
  "--encoding=UTF-8",
  "--no-show-signature",
  "--no-notes",
  "--no-patch",
  "--decorate=full",
  "--decorate-refs=refs/heads/*",
  "--decorate-refs=refs/tags/*",
  "--decorate-refs=refs/remotes/*",
  "--format=%H%x09%D"
]
const labelCacheBytes = 16 * 1024 * 1024
const maxLabelBytes = 20 * 1024 * 1024

async function scanTipLines(
  read: ReadGit,
  args: string[],
  accept: (hash: string, labels: Buffer | null) => void,
  fingerprint?: Hash
): Promise<void> {
  let pieces: Buffer[] = []
  let size = 0

  function record(line: Buffer, oversized = false): void {
    if (!line.length) return
    const split = line.indexOf(9)
    const hash = line.toString("ascii", 0, split)
    if (split < 0 || !objectId.test(hash)) throw new Error("无法解析 Git 图谱引用")
    const end = line.at(-1) === 13 ? line.length - 1 : line.length
    accept(hash, oversized ? null : line.subarray(split + 1, end))
  }

  function append(piece: Buffer): void {
    if (size <= maxLabelBytes) {
      pieces.push(piece)
      if (size + piece.length > maxLabelBytes) {
        // Keep the SHA and delimiter only. An oversized off-page label must
        // neither consume unbounded memory nor prevent this page from opening.
        pieces = [Buffer.concat(pieces, 65)]
      }
    }
    size += piece.length
  }

  function finish(): void {
    record(Buffer.concat(pieces), size > maxLabelBytes)
    pieces = []
    size = 0
  }

  function consume(chunk: Buffer): void {
    if (fingerprint) {
      // Ref names cannot contain carriage returns. Hash Git's records with LF
      // endings even when stdout emits CRLF across chunk boundaries.
      let start = 0
      for (let end = chunk.indexOf(13); end !== -1; end = chunk.indexOf(13, start)) {
        fingerprint.update(chunk.subarray(start, end))
        start = end + 1
      }
      fingerprint.update(start ? chunk.subarray(start) : chunk)
    }
    let start = 0
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const line = chunk.subarray(start, end)
      if (size) {
        append(line)
        finish()
      } else record(line, line.length > maxLabelBytes)
      start = end + 1
    }
    if (start < chunk.length) append(chunk.subarray(start))
  }
  const buffered = await read(args, undefined, consume)
  if (buffered) consume(Buffer.from(buffered))
  if (size) finish()
}

async function scanTips(read: ReadGit, head: string, accept: (hash: string, labels: Buffer | null) => void) {
  const fingerprint = createHash("sha256")
  await scanTipLines(read, [
    ...tipArgs, ...(head ? [head] : []), "--branches", "--tags", "--remotes", "--"
  ], accept, fingerprint)
  return fingerprint.digest("hex")
}

const refNamespaces = ["refs/heads/", "refs/tags/", "refs/remotes/"]
const refSeparator = Buffer.from(", ")
const tagPrefix = Buffer.from("tag: ")
const minDenseRefs = 4096
const maxDenseTips = 512
const denseProbeLimit = new Error("Dense Git ref probe exceeded its limits")

async function tryDenseRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
  signal?.throwIfAborted()
  try {
    const result = await read()
    signal?.throwIfAborted()
    return result
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && error.name === "AbortError") throw error
    // The regular Git log path remains authoritative if an optional command fails.
    return undefined
  }
}

async function hasDenseTips(read: ReadGit): Promise<boolean> {
  const tips = new Set<string>()
  let count = 0
  let tail = ""
  function record(line: string): void {
    const hash = line.endsWith("\r") ? line.slice(0, -1) : line
    if (!objectId.test(hash)) throw denseProbeLimit
    count++
    tips.add(hash)
    if (tips.size > maxDenseTips) throw denseProbeLimit
  }
  function consume(chunk: Buffer): void {
    const lines = (tail + chunk.toString("ascii")).split("\n")
    tail = lines.pop() ?? ""
    if (tail.length > 65) throw denseProbeLimit
    for (const line of lines) record(line)
  }
  // rev-parse streams only object IDs immediately. for-each-ref builds and
  // sorts the entire ref list even when the first few refs are all distinct.
  const buffered = await read(["rev-parse", "--branches", "--tags", "--remotes"], undefined, consume)
  if (buffered) consume(Buffer.from(buffered))
  if (tail) record(tail)
  return count >= minDenseRefs
}

async function readDenseTips(read: ReadGit, head: GitGraphHead, signal?: AbortSignal) {
  const names = new Map<string, Buffer[]>()
  const revisions = refNamespaces.map(() => new Set<string>())
  const revision = headRevision(head)
  const headRef = typeof head === "string" ? Buffer.from(head) : head.ref
  let headTip = objectId.test(revision) ? revision : undefined
  let size = 0
  let refCount = 0
  await scanTipLines(read, [
    "for-each-ref", "--sort=refname", "--format=%(objectname)%09%(refname)", "--", ...refNamespaces
  ], (hash, ref) => {
    const prefix = ref?.toString("ascii", 0, 13)
    const kind = refNamespaces.findIndex((ns) => prefix?.startsWith(ns))
    const existing = names.get(hash)
    size += (ref?.length ?? 0) + refSeparator.length + (kind === 1 ? tagPrefix.length : 0)
    if (!ref || kind < 0 || size > maxLabelBytes || (!existing && names.size === maxDenseTips)) {
      // The process runner stops streaming when its consumer throws. Distributed
      // refs should fall back without reading the rest of the probe's output.
      throw denseProbeLimit
    }
    refCount++
    revisions[kind].add(hash)
    if (ref.equals(headRef)) headTip = hash
    if (existing) existing.push(ref)
    else names.set(hash, [ref])
  })
  if (refCount < minDenseRefs) return
  const tips = [...new Set([...(headTip && revision ? [headTip] : []), ...revisions.flatMap((group) => [...group])])]
  // Git resolves decorations one object at a time, even for many refs with the same SHA.
  // Batch-check the unique objects here and let the native path peel any annotated tags.
  const types = await read(["cat-file", "--batch-check=%(objectname) %(objecttype)"], tips.join("\n") + "\n")
  if (types.trimEnd().replaceAll("\r\n", "\n") !== tips.map((hash) => `${hash} commit`).join("\n")) return
  const labels = new Map<string, Buffer>()
  let processed = 0
  for (const [hash, refs] of names) {
    const tokens: Buffer[] = []
    // Git prepends decorations as it visits refs in name order.
    for (let i = refs.length - 1; i >= 0; i--) {
      const ref = refs[i]
      if (tokens.length) tokens.push(refSeparator)
      if (ref.toString("ascii", 0, refNamespaces[1].length) === refNamespaces[1]) tokens.push(tagPrefix)
      tokens.push(ref)
      if (++processed % 4096 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        signal?.throwIfAborted()
      }
    }
    labels.set(hash, Buffer.concat(tokens))
  }
  // Match Git's `%H%x09%D` records so a fallback can continue an existing page.
  const fingerprint = createHash("sha256")
  for (const hash of tips) {
    fingerprint.update(`${hash}\t`)
    const decorations = labels.get(hash)
    if (decorations) fingerprint.update(decorations)
    fingerprint.update("\n")
  }
  return { tips, labels, digest: fingerprint.digest("hex"), rawHeadTip: revision ? undefined : headTip }
}

async function readDecoratedTips(read: ReadGit, head: GitGraphHead) {
  const tips: string[] = []
  const labels = new Map<string, Buffer | null>()
  const retainedBuffers = new WeakSet<ArrayBufferLike>()
  const revision = headRevision(head)
  const rawHead = !revision && typeof head !== "string" ? head.ref : undefined
  let rawHeadTip: string | undefined
  let bytes = 0
  const digest = await scanTips(read, revision, (hash, decorations) => {
    tips.push(hash)
    if (rawHead && !rawHeadTip && decorations && headDecorationOffset(decorations, rawHead) !== -1) {
      rawHeadTip = hash
    }
    if (bytes > labelCacheBytes) return
    // Retain Git's raw buffers and decode only visible labels. A short slice may keep
    // an entire stdout chunk alive, so charge each backing buffer at its full size once.
    bytes += hash.length
    if (decorations && !retainedBuffers.has(decorations.buffer)) {
      retainedBuffers.add(decorations.buffer)
      bytes += decorations.buffer.byteLength
    }
    if (bytes <= labelCacheBytes) labels.set(hash, decorations)
  })
  return { tips, labels, digest, rawHeadTip }
}

async function readPage(
  read: ReadGit,
  skip: number,
  previous: string | undefined,
  boundary: string,
  forDialog: boolean,
  head: GitGraphHead,
  denseCandidate: boolean,
  signal?: AbortSignal
) {
  const dense = denseCandidate && boundary === "\0"
    ? await tryDenseRead(() => readDenseTips(read, head, signal), signal)
    : undefined
  const { tips, labels, digest, rawHeadTip } = dense ?? await readDecoratedTips(read, head)
  const snapshot = createHash("sha256")
    .update(JSON.stringify([headIdentity(head), boundary, digest]))
    .digest("hex")
  const reset = previous !== undefined && previous !== snapshot
  // Pin the walk to immutable objects even if a branch moves and moves back
  // while Git is reading. Never decorate this page from live branch names.
  // A ref with undecodable bytes cannot be passed as a Git argument. Promote
  // its captured commit for the walk, leaving the ordered snapshot records intact.
  const walkTips = rawHeadTip && rawHeadTip !== tips[0]
    ? [rawHeadTip, ...tips.filter((tip) => tip !== rawHeadTip)]
    : tips
  const output = walkTips.length
    ? await read(
        [
          "log",
          "--no-color",
          "--encoding=UTF-8",
          "--no-show-signature",
          "--no-notes",
          "--no-patch",
          "--no-decorate",
          "--topo-order",
          `--skip=${reset ? 0 : skip}`,
          `--max-count=${pageSize + 1}`,
          "-z",
          "--format=%H%x00%P%x00%an%x00%at%x00%s",
          "--stdin",
          "--"
        ],
        walkTips.join("\n") + "\n"
      )
    : ""
  const fields = output.split("\0")
  const commits: GitGraphPage["commits"] = []
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [hash, parents, author, seconds, subject] = fields.slice(i, i + 5)
    if (!objectId.test(hash)) throw new Error("无法解析 Git 图谱提交")
    commits.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      timestamp: Number(seconds) * 1000,
      subject,
      refs: []
    })
  }
  const hasMore = commits.length > pageSize
  if (hasMore) commits.pop()
  if (!dense && labels.size < tips.length && commits.some(({ hash }) => !labels.has(hash))) {
    // The cache holds a prefix of Git's unique tips. An undecorated ancestor
    // has no entry anywhere in the tip list and does not require another scan.
    const pageHashes = new Set(commits.map((commit) => commit.hash))
    let needsLabels = false
    for (let i = labels.size; i < tips.length; i++) {
      if (pageHashes.has(tips[i])) {
        needsLabels = true
        break
      }
      if (i % 16384 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        signal?.throwIfAborted()
      }
    }
    if (needsLabels) {
      labels.clear()
      let pageLabelBytes = 0
      let labelError: string | undefined
      const verified = await scanTips(read, headRevision(head), (hash, decorations) => {
        if (labelError || !pageHashes.has(hash)) return
        if (!decorations) {
          labelError = "单条提交的 Git 引用过多"
          return
        }
        pageLabelBytes += decorations.length
        if (pageLabelBytes > maxLabelBytes) labelError = "当前图谱页的 Git 引用过多"
        else labels.set(hash, decorations)
      })
      if (verified !== digest) return null
      if (labelError) throw new Error(labelError)
    }
  }
  for (const commit of commits) {
    const decorations = labels.get(commit.hash)
    if (decorations === null) throw new Error("单条提交的 Git 引用过多")
    await assignCommitRefs(commit, decorations, head, forDialog, signal)
  }
  return { commits, hasMore, snapshot, reset }
}

export async function readCommitGraph(
  read: ReadGit,
  skip: number,
  previousSnapshot?: string,
  signal?: AbortSignal,
  forDialog = false
): Promise<GitGraphPage> {
  // Both observations must bracket the walk. They can run concurrently within each check.
  const readState = () => Promise.all([readHistoryBoundary(read, signal), readHead(read)])
  const [initial, denseCandidate] = await Promise.all([
    readState(),
    forDialog && process.env.GIT_REPLACE_REF_BASE === undefined
      ? tryDenseRead(() => hasDenseTips(read), signal)
      : undefined
  ])
  let [boundary, head] = initial
  for (let attempt = 0; attempt < 2; attempt++) {
    const page = await readPage(
      read, attempt ? 0 : skip, previousSnapshot, boundary, forDialog, head, denseCandidate === true, signal
    )
    const [nextBoundary, nextHead] = await readState()
    if (page && boundary === nextBoundary && headIdentity(head) === headIdentity(nextHead)) {
      return attempt ? { ...page, reset: true } : page
    }
    boundary = nextBoundary
    head = nextHead
  }
  throw new Error("读取期间仓库历史持续变化，请刷新图谱重试")
}
