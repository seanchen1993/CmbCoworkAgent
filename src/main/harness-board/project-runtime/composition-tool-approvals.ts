import type { ProjectCompositionToolApproval } from "../../../shared/project-runtime/composition-api"
import {
  approvalDecisionBroker,
  type ApprovalDecisionBroker,
  type ApprovalBrokerRegistration
} from "../../agent/approval-decision-broker"

function canAllow(request: ApprovalBrokerRegistration["request"]): boolean {
  return (
    request.operation !== "git_commit" &&
    request.operation !== "git_push" &&
    request.allowed_approval_types.includes("approve")
  )
}

/** The caller resolves current execution threads from the host, never from renderer input. */
export class CompositionToolApprovals {
  constructor(private readonly broker: ApprovalDecisionBroker = approvalDecisionBroker) {}

  list(units: Array<{ unitId: string; threadIds: string[] }>): ProjectCompositionToolApproval[] {
    const pending = this.broker.list()
    return units.flatMap(({ unitId, threadIds }) =>
      pending
        .filter((entry) => threadIds.includes(entry.runtimeThreadId))
        .map(({ request }) => ({
          unitId,
          requestId: request.id,
          operation: request.operation ?? request.tool_call?.name ?? "execute",
          command: request.command,
          filePath: request.filePath,
          code: request.code,
          cwd: request.cwd,
          reason: request.reason,
          allow: canAllow(request)
        }))
    )
  }

  respond(input: {
    requestId: string
    threadIds: string[]
    decision: "allow" | "deny"
    webContentsId: number
  }): void {
    const entry = this.broker.get(input.requestId)
    if (!entry || !input.threadIds.includes(entry.runtimeThreadId))
      throw Error("COMPOSITION_TOOL_APPROVAL_CHANGED")
    if (input.decision !== "allow" && input.decision !== "deny")
      throw Error("COMPOSITION_TOOL_APPROVAL_INVALID")
    if (input.decision === "allow" && !canAllow(entry.request))
      throw Error("COMPOSITION_TOOL_APPROVAL_UNSUPPORTED")
    const result = this.broker.decide({
      source: { kind: "desktop", webContentsId: input.webContentsId },
      requestId: input.requestId,
      decision: {
        type: input.decision === "allow" ? "approve" : "reject",
        tool_call_id: entry.request.tool_call?.id ?? ""
      }
    })
    if (!result.accepted) throw Error("COMPOSITION_TOOL_APPROVAL_CHANGED")
  }
}
