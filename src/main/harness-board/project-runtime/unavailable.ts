import { registerAgentRunAdmission } from "../../agent/agent-run-admission"
import { registerFlowRuntimeAdmission } from "../../mods/flows/runtime-admission"
import { registerLegacyProjectEntryGate } from "./legacy-entry-gate"

/** A damaged opt-in ledger must neither stop ordinary chat nor silently lose its source fence. */
export function registerUnavailableLegacyRuntime(
  projectForThread: (threadId: string) => string | undefined,
  readProtectedProjects?: () => Pick<ReadonlySet<string>, "has"> | undefined
) {
  const reject = () => { throw Error("PROJECT_LEGACY_RUNTIME_UNAVAILABLE") }
  const assertProject = (projectId: string) => {
    const protectedProjects = readProtectedProjects?.()
    if (!protectedProjects || protectedProjects.has(projectId)) reject()
  }
  const assertThread = (threadId: string) => {
    const projectId = projectForThread(threadId)
    if (projectId) assertProject(projectId)
  }
  const stopAgent = registerAgentRunAdmission(async request => {
    assertThread(request.threadId)
    return undefined
  })
  let stopFlow: (() => void) | undefined
  let stopGate: (() => void) | undefined
  try {
    stopFlow = registerFlowRuntimeAdmission(async request => {
      assertThread(request.threadId)
      return undefined
    })
    stopGate = registerLegacyProjectEntryGate(assertProject, (projectId, _workspace, work) => {
      assertProject(projectId)
      return work(undefined)
    })
  } catch (error) {
    stopFlow?.()
    stopAgent()
    throw error
  }
  return () => { stopGate?.(); stopFlow?.(); stopAgent() }
}
