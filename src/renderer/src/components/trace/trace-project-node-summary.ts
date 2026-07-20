interface ProjectTraceAttribution {
  harnessProjectId?: string
  harnessNodeName?: string
}

export interface ThreadProjectNodeSummary {
  isProjectMode: boolean
  visitedNodeNames: string[]
}

/** Aggregate project workflow nodes that a thread has visited, regardless of node status. */
export function summarizeThreadProjectNodes(
  traces: readonly ProjectTraceAttribution[]
): ThreadProjectNodeSummary {
  const visitedNodeNames = new Set<string>()
  let isProjectMode = false

  for (const trace of traces) {
    const projectId = trace.harnessProjectId?.trim()
    if (!projectId) continue
    isProjectMode = true
    const nodeName = trace.harnessNodeName?.trim()
    if (nodeName) visitedNodeNames.add(nodeName)
  }

  return { isProjectMode, visitedNodeNames: [...visitedNodeNames] }
}
