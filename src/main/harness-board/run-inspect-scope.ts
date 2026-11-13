import {
  captureRuntimePluginSourceContentGuard,
  currentRuntimePluginSource
} from "../plugins/runtime-source-scope"
import { isInternalHarnessProjectId, readInternalHarnessProject } from "./internal-project-context"

/** A cache decision only: this never creates a source, grant, receipt or execution admission. */
export async function runScopedHarnessInspection<T>(
  input: { projectId: string; readonlyPackage?: boolean; signal?: AbortSignal },
  ordinary: () => Promise<T>,
  protectedRead: (beforeSpawn: () => void) => Promise<T>
): Promise<T> {
  const source = currentRuntimePluginSource()
  const internal = isInternalHarnessProjectId(input.projectId)
  if (!source && !internal && !input.readonlyPackage) return ordinary()
  const assertSource = source ? captureRuntimePluginSourceContentGuard() : undefined
  const assertCurrent = () => {
    input.signal?.throwIfAborted()
    assertSource?.()
    if (internal && !readInternalHarnessProject(input.projectId)) {
      throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
    }
  }
  assertCurrent()
  const result = await protectedRead(assertCurrent)
  assertCurrent()
  return result
}
