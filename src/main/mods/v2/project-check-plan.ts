import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import type { ProjectCheckKind } from "./project-checks"

export interface ProjectCheckPlan {
  kind: ProjectCheckKind
  command: string
  cwd: string
}

/** Select a fixed project entrypoint; never install a runner or interpolate a script body. */
export async function planProjectCheck(
  workspace: string,
  kind: ProjectCheckKind,
  signal?: AbortSignal
): Promise<ProjectCheckPlan> {
  signal?.throwIfAborted()
  const cwd = resolve(workspace)
  const opened = await openStableFileHandle(cwd, join(cwd, "package.json"))
  let manifest: unknown
  try {
    manifest = JSON.parse((await readStableFileHandleBounded(opened, 128 * 1024)).toString("utf8"))
  } finally {
    await opened.handle.close()
  }
  signal?.throwIfAborted()
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw Error("PROJECT_MANIFEST_INVALID")
  const scripts = (manifest as { scripts?: unknown }).scripts
  const names = kind === "unit-test" ? ["test:unit", "test"] : ["test:e2e", "e2e"]
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    for (const name of names) {
      const script = (scripts as Record<string, unknown>)[name]
      if (typeof script === "string" && script.trim())
        return { kind, cwd, command: `npm run ${name}` }
    }
  }
  const entry = kind === "unit-test" ? "node_modules/vitest/vitest.mjs" : "tests/run-mods-e2e.mjs"
  const file = await stat(join(cwd, entry)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  signal?.throwIfAborted()
  if (!file?.isFile()) throw Error(`PROJECT_CHECK_UNAVAILABLE: ${kind}`)
  return { kind, cwd, command: `node ${entry}${kind === "unit-test" ? " run" : ""}` }
}
