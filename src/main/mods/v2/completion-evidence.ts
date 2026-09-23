import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { lstat, opendir, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import type { ModJson } from "../../../shared/mods/types"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

const execute = promisify(execFile)
const MAX_FILES = 2048
const MAX_ENTRIES = 8192
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024

export interface CompletionFileFingerprint {
  path: string
  sha256: string
  size: number
}

export interface CompletionEvidenceBinding {
  workspace: string
  threadId: string
  turnId: string
  runId: string
  pluginDigests: Record<string, string>
  runtimeGeneration: number
  diffFingerprint: string
  /** Present for Git workspaces; omitted for older evidence and non-Git projects. */
  diffFiles?: string[]
  stateFingerprint: string
  requirementVersion: string
  configFingerprint: string
  files: CompletionFileFingerprint[]
}

interface CompletionRecordIdentity {
  id: string
  idempotencyKey: string
  workspace: string
  threadId: string
  turnId: string
  runId: string
  detail?: ModJson
  at: number
}

export interface BoundCompletionEvidenceRecord extends CompletionRecordIdentity {
  phase:
    | "check.started"
    | "check.result"
    | "repair.attempt"
    | "validator.result"
    | "state.transition"
    | "invalidated"
  status: "running" | "pass" | "revise" | "block" | "stale" | "cancelled" | "error" | "interrupted"
  binding: CompletionEvidenceBinding
}

/** A failed capture has execution identity but no file, requirement or checkpoint proof. */
export interface UnboundCompletionEvidenceRecord extends CompletionRecordIdentity {
  phase: "capture.failed"
  status: "cancelled" | "error" | "interrupted"
  binding: null
  capture: Pick<
    CompletionEvidenceBinding,
    | "workspace"
    | "threadId"
    | "turnId"
    | "runId"
    | "pluginDigests"
    | "runtimeGeneration"
    | "configFingerprint"
  >
}

export type CompletionEvidenceRecord =
  | BoundCompletionEvidenceRecord
  | UnboundCompletionEvidenceRecord

export interface CompletionCaptureInput {
  workspace: string
  threadId: string
  turnId: string
  runId?: string
  pluginDigests: Record<string, string>
  runtimeGeneration: number
  config?: ModJson
  paths?: string[]
  excludePaths?: string[]
  signal?: AbortSignal
  assertLive?(): void
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

async function git(input: CompletionCaptureInput, args: string[]): Promise<string> {
  const result = await execute("git", ["--no-optional-locks", "-C", input.workspace, ...args], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    signal: input.signal
  })
  return result.stdout
}

/** Bounded complete enumeration: exceeding a limit fails rather than silently omitting evidence. */
function visitEntry(visited: Set<string>, path: string): boolean {
  if (visited.has(path)) return false
  if (visited.size >= MAX_ENTRIES) throw Error("COMPLETION_EVIDENCE_ENTRY_LIMIT")
  visited.add(path)
  return true
}

async function collectFiles(
  input: CompletionCaptureInput,
  prefix: string,
  output: Set<string>,
  budget: { entries: Set<string>; visited: Set<string> },
  depth = 0
): Promise<void> {
  input.signal?.throwIfAborted()
  input.assertLive?.()
  if (depth > 24) throw Error("COMPLETION_EVIDENCE_DEPTH")
  const absolute = resolve(input.workspace, prefix)
  const child = relative(resolve(input.workspace), absolute)
  if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\"))
    throw Error("COMPLETION_EVIDENCE_PATH")
  if (budget.visited.has(absolute)) return
  visitEntry(budget.entries, absolute)
  budget.visited.add(absolute)
  if (input.excludePaths?.some((path) => resolve(path) === absolute)) return
  const item = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!item) {
    output.add(prefix)
    return
  }
  if (item.isSymbolicLink()) throw Error("COMPLETION_EVIDENCE_LINK")
  if (item.isFile()) {
    output.add(prefix)
    return
  }
  if (!item.isDirectory()) throw Error("COMPLETION_EVIDENCE_FILE_TYPE")
  const directory = await opendir(absolute)
  for await (const entry of directory) {
    if (
      [".git", "node_modules", "dist", "out", "build", ".codex", "__pycache__"].includes(entry.name)
    ) {
      visitEntry(budget.entries, join(absolute, entry.name))
      continue
    }
    if (output.size >= MAX_FILES) throw Error("COMPLETION_EVIDENCE_FILE_LIMIT")
    await collectFiles(
      input,
      prefix ? `${prefix}/${entry.name}` : entry.name,
      output,
      budget,
      depth + 1
    )
  }
}

export async function captureCompletionBinding(
  input: CompletionCaptureInput
): Promise<CompletionEvidenceBinding> {
  input.signal?.throwIfAborted()
  input.assertLive?.()
  if (relative(resolve(input.workspace), await realpath(input.workspace)) !== "")
    throw Error("COMPLETION_EVIDENCE_ROOT_CHANGED")
  const candidates = new Set<string>()
  const budget = { entries: new Set<string>(), visited: new Set<string>() }
  for (const path of input.paths ?? []) {
    await collectFiles(input, path === "." ? "" : path, candidates, budget)
  }
  let diff = "non-git"
  let diffFiles: string[] | undefined
  let repository = false
  try {
    repository = (await git(input, ["rev-parse", "--is-inside-work-tree"])).trim() === "true"
  } catch (error) {
    input.signal?.throwIfAborted()
    if (!(error && typeof error === "object" && "code" in error && error.code === 128)) throw error
  }
  if (repository) {
    const [head, unstaged, staged, paths, stagedPaths] = await Promise.all([
      git(input, ["rev-parse", "--verify", "HEAD"]).catch((error: NodeJS.ErrnoException) => {
        input.signal?.throwIfAborted()
        if (Number(error.code) === 128) return "unborn"
        throw error
      }),
      git(input, ["diff", "--no-ext-diff", "--no-textconv", "--binary"]),
      git(input, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"]),
      git(input, ["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"]),
      git(input, ["diff", "--cached", "--name-only", "--no-renames", "-z"])
    ])
    diffFiles = [...new Set((paths + stagedPaths).split("\0").filter(Boolean))].sort()
    diff = JSON.stringify([head, unstaged, staged, diffFiles])
    for (const path of diffFiles) candidates.add(path)
  } else await collectFiles(input, "", candidates, budget)
  if (await lstat(join(input.workspace, ".autobizdevops")).catch(() => undefined))
    await collectFiles(input, ".autobizdevops", candidates, budget)
  if (candidates.size > MAX_FILES) throw Error("COMPLETION_EVIDENCE_FILE_LIMIT")
  let total = 0
  const files: CompletionFileFingerprint[] = []
  for (const path of [...candidates].sort()) {
    input.signal?.throwIfAborted()
    input.assertLive?.()
    const absolute = resolve(input.workspace, path)
    const child = relative(input.workspace, absolute)
    if (isAbsolute(child) || child === ".." || child.startsWith("../") || child.startsWith("..\\"))
      throw Error("COMPLETION_EVIDENCE_PATH")
    if (input.excludePaths?.some((path) => resolve(path) === absolute)) continue
    const item = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!item) {
      files.push({ path, size: -1, sha256: "missing" })
      continue
    }
    if (item.isSymbolicLink() || !item.isFile()) throw Error("COMPLETION_EVIDENCE_FILE_TYPE")
    const opened = await openStableFileHandle(input.workspace, absolute)
    try {
      const bytes = await readStableFileHandleBounded(
        opened,
        Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)
      )
      total += bytes.length
      files.push({ path: path.replace(/\\/g, "/"), size: bytes.length, sha256: sha256(bytes) })
    } finally {
      await opened.handle.close()
    }
  }
  input.signal?.throwIfAborted()
  input.assertLive?.()
  return {
    workspace: resolve(input.workspace),
    threadId: input.threadId,
    turnId: input.turnId,
    runId: input.runId || `completion:${input.threadId}:${input.turnId}`,
    pluginDigests: Object.fromEntries(Object.entries(input.pluginDigests).sort()),
    runtimeGeneration: input.runtimeGeneration,
    diffFingerprint: sha256(diff),
    ...(diffFiles ? { diffFiles } : {}),
    stateFingerprint:
      files.find((file) => file.path === ".autobizdevops/state.json")?.sha256 ?? "missing",
    requirementVersion: sha256(
      JSON.stringify(
        files.filter((file) =>
          /(^|\/)(requirements?|proposal|spec|prd|design|plan|state|workflow\.d)([^/]*)/i.test(
            file.path
          )
        )
      )
    ),
    configFingerprint: sha256(JSON.stringify(input.config ?? null)),
    files
  }
}

export function bindingFingerprint(binding: CompletionEvidenceBinding): string {
  return sha256(JSON.stringify(binding))
}

export function sameCompletionBinding(
  expected: CompletionEvidenceBinding,
  actual: CompletionEvidenceBinding
): boolean {
  return bindingFingerprint(expected) === bindingFingerprint(actual)
}
