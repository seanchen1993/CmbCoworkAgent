import {
  projectHarnessPluginRunArtifacts,
  type HarnessPluginRunArtifactFile
} from "../../../shared/harness-plugin-run-artifacts"
import type { HarnessRunDetailViewModel } from "@/types"

export type { HarnessPluginRunArtifactFile }

export const HARNESS_PLUGIN_RUN_ARTIFACT_GRANT_REFRESH_SKEW_MS = 15_000

export interface HarnessPluginRunArtifactPreviewAuthorization {
  grant: string
  expiresAt: number
  projectId: string
  slug: string
  filePath: string
}

export type HarnessPluginRunArtifactGrantRefresher = (input: {
  projectId: string
  slug: string
  filePath: string
}) => Promise<
  | { success: true; grant: string; expiresAt: number }
  | { success: false; error: string }
>

export interface HarnessPluginRunArtifactsContext {
  projectId: string
  slug: string
  projectRootPath: string
  threadIds: string[]
  files: HarnessPluginRunArtifactFile[]
  truncated: boolean
  previewGrant?: string
  previewGrantExpiresAt?: number
}

export function buildHarnessPluginRunArtifactsContext(
  detail: HarnessRunDetailViewModel,
  threadIds: string[] = detail.sessions.map((session) => session.threadId)
): HarnessPluginRunArtifactsContext {
  const projection = projectHarnessPluginRunArtifacts(detail)
  const hasPreviewGrantExpiry =
    typeof detail.artifactPreviewGrantExpiresAt === "number" &&
    Number.isFinite(detail.artifactPreviewGrantExpiresAt)

  return {
    projectId: detail.project.projectId,
    slug: detail.run.slug,
    projectRootPath: detail.project.projectRootPath,
    threadIds,
    files: projection.files,
    truncated: projection.truncated,
    ...(detail.artifactPreviewGrant && hasPreviewGrantExpiry
      ? {
          previewGrant: detail.artifactPreviewGrant,
          previewGrantExpiresAt: detail.artifactPreviewGrantExpiresAt
        }
      : {})
  }
}

export function isHarnessPluginRunArtifactGrantFresh(
  grant: string | undefined,
  expiresAt: number | undefined,
  now = Date.now()
): boolean {
  return Boolean(
    grant &&
      typeof expiresAt === "number" &&
      Number.isFinite(expiresAt) &&
      expiresAt - now > HARNESS_PLUGIN_RUN_ARTIFACT_GRANT_REFRESH_SKEW_MS
  )
}

/**
 * Renew an already-open artifact preview only when its capability is near
 * expiry. The caller owns single-flight coordination and state replacement so
 * React surfaces can reject a renewal that finishes after a task switch.
 */
export async function ensureHarnessPluginRunArtifactPreviewAuthorization(
  authorization: HarnessPluginRunArtifactPreviewAuthorization,
  refresh: HarnessPluginRunArtifactGrantRefresher,
  now = Date.now()
): Promise<HarnessPluginRunArtifactPreviewAuthorization> {
  if (
    isHarnessPluginRunArtifactGrantFresh(
      authorization.grant,
      authorization.expiresAt,
      now
    )
  ) {
    return authorization
  }
  const result = await refresh({
    projectId: authorization.projectId,
    slug: authorization.slug,
    filePath: authorization.filePath
  })
  if (!result.success) throw new Error(result.error)
  return {
    ...authorization,
    grant: result.grant,
    expiresAt: result.expiresAt
  }
}

function normalizeAbsolutePath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, "/")
  let prefix: string
  let remainder: string
  const uncRoot = normalized.match(/^(\/\/[^/]+\/[^/]+)(?:\/|$)/)
  const driveRoot = normalized.match(/^([a-zA-Z]:)(?:\/|$)/)
  if (uncRoot) {
    prefix = uncRoot[1]
    remainder = normalized.slice(uncRoot[0].length)
  } else if (driveRoot) {
    prefix = driveRoot[1]
    remainder = normalized.slice(driveRoot[0].length)
  } else if (normalized.startsWith("/")) {
    prefix = "/"
    remainder = normalized.replace(/^\/+/, "")
  } else {
    return null
  }
  const segments: string[] = []
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (prefix === "/") return `/${segments.join("/")}`
  return segments.length > 0 ? `${prefix}/${segments.join("/")}` : `${prefix}/`
}

function pathComparisonKey(path: string): string {
  return /^(?:[a-zA-Z]:\/|\/\/)/.test(path) ? path.toLowerCase() : path
}

export function resolveHarnessPluginRunArtifactPath(
  projectRootPath: string,
  artifactPath: string
): string | null {
  const normalizedRoot = normalizeAbsolutePath(projectRootPath)
  if (!normalizedRoot) return null

  const normalizedArtifactPath = artifactPath.trim().replace(/\\/g, "/")
  if (!normalizedArtifactPath) return null
  const candidate = /^(?:[a-zA-Z]:\/|\/)/.test(normalizedArtifactPath)
    ? normalizeAbsolutePath(normalizedArtifactPath)
    : normalizeAbsolutePath(`${normalizedRoot}/${normalizedArtifactPath.replace(/^\/+/, "")}`)
  if (!candidate) return null

  const rootKey = pathComparisonKey(normalizedRoot)
  const candidateKey = pathComparisonKey(candidate)
  const rootBoundary = rootKey.endsWith("/") ? rootKey : `${rootKey}/`
  if (candidateKey !== rootKey && !candidateKey.startsWith(rootBoundary)) return null
  return candidate
}

export function areHarnessPluginRunArtifactsContextsEqual(
  left: HarnessPluginRunArtifactsContext | null,
  right: HarnessPluginRunArtifactsContext | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (
    left.projectId !== right.projectId ||
    left.slug !== right.slug ||
    left.projectRootPath !== right.projectRootPath ||
    left.previewGrant !== right.previewGrant ||
    left.previewGrantExpiresAt !== right.previewGrantExpiresAt ||
    left.truncated !== right.truncated ||
    left.threadIds.length !== right.threadIds.length ||
    left.files.length !== right.files.length
  ) {
    return false
  }
  for (let index = 0; index < left.threadIds.length; index += 1) {
    if (left.threadIds[index] !== right.threadIds[index]) return false
  }
  for (let index = 0; index < left.files.length; index += 1) {
    const leftFile = left.files[index]
    const rightFile = right.files[index]
    if (leftFile.path !== rightFile.path || leftFile.artifactType !== rightFile.artifactType) {
      return false
    }
  }
  return true
}

let currentHarnessPluginRunArtifacts: HarnessPluginRunArtifactsContext | null = null
const harnessPluginRunArtifactsListeners = new Set<() => void>()

/**
 * Publish the selected feature's bounded artifact projection without lifting it
 * into App state. Only the right panel subscribes, so a watch refresh cannot
 * trigger a second render of the entire Harness board.
 */
export function publishHarnessPluginRunArtifacts(
  context: HarnessPluginRunArtifactsContext | null
): void {
  if (areHarnessPluginRunArtifactsContextsEqual(currentHarnessPluginRunArtifacts, context)) {
    return
  }
  currentHarnessPluginRunArtifacts = context
  for (const listener of harnessPluginRunArtifactsListeners) listener()
}

export function getHarnessPluginRunArtifactsSnapshot(): HarnessPluginRunArtifactsContext | null {
  return currentHarnessPluginRunArtifacts
}

export function subscribeHarnessPluginRunArtifacts(listener: () => void): () => void {
  harnessPluginRunArtifactsListeners.add(listener)
  return () => harnessPluginRunArtifactsListeners.delete(listener)
}
