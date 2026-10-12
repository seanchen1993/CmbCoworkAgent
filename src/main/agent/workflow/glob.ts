import fastGlob from "fast-glob"
import { isAbsolute } from "node:path"
import { getWorkflowGlobMax, WorkflowFatalError } from "./types"

/** Shared bounded traversal from the workflow engine. Callers apply their own
 * capability checks to the returned relative paths before exposing them. */
export async function globWorkflowFiles(
  workspacePath: string,
  pattern: string,
  check: () => void = () => {}
): Promise<string[]> {
  check()
  const maxResults = getWorkflowGlobMax()
  // STREAM + count as we walk, so the moment we cross maxResults we abort
  // the traversal itself — never materializing the full path array for a
  // pathological pattern. (A post-hoc length check on `await fastGlob(...)` would
  // only protect the downstream fan-out, AFTER the whole tree was walked and the
  // giant array allocated on the main process.)
  const stream = fastGlob.stream(pattern, {
    cwd: workspacePath,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    absolute: false,
    suppressErrors: true,
    // Skip the universal build/VCS noise. A workflow orchestrating over a repo
    // virtually never wants node_modules/.git, and on a real project including
    // them both floods the fan-out with junk and blows the result set past
    // maxResults. (dist is intentionally NOT excluded — it's project-specific
    // and sometimes holds source the script legitimately wants.)
    ignore: ["**/node_modules/**", "**/.git/**"]
  })
  const safe: string[] = []
  for await (const entry of stream) {
    check()
    const m = String(entry)
    // Defensive: drop any match that escaped the cwd.
    if (m.startsWith("..") || isAbsolute(m)) continue
    safe.push(m)
    if (safe.length > maxResults) {
      // Throwing breaks the for-await, whose return() tears the stream down, so we
      // stop enumerating the tree instead of walking it to completion + allocating
      // the whole array.
      throw new WorkflowFatalError(
        `glob("${pattern}") matched more than ${maxResults} files (limit ${maxResults}) — narrow the pattern`
      )
    }
  }
  check()
  // SORT for deterministic fan-out order (the resume journal keys on call order,
  // so order must be stable between the original and resumed runs).
  return safe.sort()
}
