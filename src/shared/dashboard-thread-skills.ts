/** App-side view model only; no additional fields are uploaded to ES. */
export interface DashboardThreadSkillSource {
  threadId: string | null
  traceId: string | null
  label: string
  isSubagent: boolean
}

export interface DashboardThreadSkill {
  skill: string
  sources: DashboardThreadSkillSource[]
}

export function threadSkillSource(trace: {
  threadId?: string
  traceId?: string
  traceKind?: string
  executionMode?: string
  parentTraceId?: string
  parentThreadId?: string
  subagentKind?: string
  coordinatorWorkerRole?: string
  coordinatorWorkerId?: string
  workflowAgentLabel?: string
}): DashboardThreadSkillSource {
  const isSubagent =
    trace.traceKind === "subagent" ||
    Boolean(trace.parentTraceId || trace.parentThreadId || trace.subagentKind)
  let label = isSubagent ? "子 Agent" : "主 Agent"
  if (trace.subagentKind === "coordinator_worker") {
    const role = trace.coordinatorWorkerRole === "verifier" ? "Verifier" : "Worker"
    label = `Team ${role}${trace.coordinatorWorkerId ? ` ${trace.coordinatorWorkerId}` : ""}`
  } else if (trace.subagentKind === "workflow_agent") {
    label = `Workflow ${trace.workflowAgentLabel || "子 Agent"}`
  } else if (trace.subagentKind === "task") label = "Task 子 Agent"
  else if (isSubagent && trace.executionMode === "coordinator") label = "Team 子 Agent"
  else if (isSubagent && trace.executionMode === "workflow") label = "Workflow 子 Agent"
  return {
    threadId: trace.threadId || null,
    traceId: trace.traceId || null,
    label,
    isSubagent
  }
}

export function summarizeThreadSkills(
  traces: Array<Parameters<typeof threadSkillSource>[0] & { usedSkills: string[] }>
): DashboardThreadSkill[] {
  const skills = new Map<string, Map<string, DashboardThreadSkillSource>>()
  for (const trace of traces) {
    const source = threadSkillSource(trace)
    for (const skill of trace.usedSkills) {
      if (!skill.trim()) continue
      let sources = skills.get(skill)
      if (!sources) skills.set(skill, (sources = new Map()))
      const key = source.threadId ?? source.traceId ?? source.label
      if (!sources.has(key)) sources.set(key, source)
    }
  }
  return Array.from(skills, ([skill, sources]) => ({ skill, sources: [...sources.values()] })).sort(
    (a, b) => a.skill.localeCompare(b.skill)
  )
}
