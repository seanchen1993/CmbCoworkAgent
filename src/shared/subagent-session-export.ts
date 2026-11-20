export type SubagentExportTarget =
  | { kind: "multi"; threadId: string; subagentId: string }
  | { kind: "workflow"; threadId: string; runId: string; agentIndex: number }
  | { kind: "worker"; threadId: string; workerThreadId: string }
