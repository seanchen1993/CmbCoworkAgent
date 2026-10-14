import { createHash } from "node:crypto"
import { join } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

export const PROJECT_CHECK_CONFIG = ".cmb/project-checks.json"
export interface PythonUnitTestConfig {
  runner: "python-unittest"
  startDirectory: string
  pattern: string
}

/** Read bytes even for evidence capture: malformed configuration still changes its identity. */
export async function readProjectCheckConfig(workspace: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const opened = await openStableFileHandle(workspace, join(workspace, PROJECT_CHECK_CONFIG)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }
  )
  if (!opened) return { digest: "missing", text: undefined }
  try {
    const bytes = await readStableFileHandleBounded(opened, 16 * 1024)
    signal?.throwIfAborted()
    return {
      digest: createHash("sha256").update(bytes).digest("hex"),
      text: bytes.toString("utf8")
    }
  } finally {
    await opened.handle.close()
  }
}

export function parseProjectCheckConfig(text: string): PythonUnitTestConfig {
  const invalid = () => Error("PROJECT_CHECK_CONFIG_INVALID")
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalid()
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const raw = value as Record<string, unknown>
  if (
    raw.schemaVersion !== 1 ||
    Object.keys(raw).some((key) => !["schemaVersion", "unitTest"].includes(key))
  )
    throw invalid()
  if (!raw.unitTest || typeof raw.unitTest !== "object" || Array.isArray(raw.unitTest))
    throw invalid()
  const unit = raw.unitTest as Record<string, unknown>
  if (
    unit.runner !== "python-unittest" ||
    Object.keys(unit).some((key) => !["runner", "startDirectory", "pattern"].includes(key))
  )
    throw invalid()
  const { startDirectory, pattern } = unit
  // Deliberately narrow argv, safe inside double quotes on supported Windows/POSIX shells.
  if (
    typeof startDirectory !== "string" ||
    startDirectory.length > 160 ||
    !/^[A-Za-z0-9_][A-Za-z0-9_/-]*$/.test(startDirectory) ||
    startDirectory.split("/").some((part) => !part || part.startsWith("-"))
  )
    throw invalid()
  if (
    typeof pattern !== "string" ||
    pattern.length > 100 ||
    !/^test_[A-Za-z0-9_*?-]+\.py$/.test(pattern)
  )
    throw invalid()
  return { runner: "python-unittest", startDirectory, pattern }
}
