import type {
  Approval,
  ArtifactVersionRef,
  Bot,
  CreateRunRequest,
  Group,
  RunStatus,
  RuntimeEnvelope
} from "../../src/shared/bot/contracts.generated"

declare const message: RuntimeEnvelope
if (message.type === "accepted") {
  const fence: number = message.body.fence
  void fence
  // @ts-expect-error accepted is not a node registration body
  message.body.nodeId
}
if (message.type === "event" && message.body.eventType === "completed") {
  const artifacts: ArtifactVersionRef[] = message.body.data.artifactVersions
  void artifacts
  // @ts-expect-error completed is not progress data
  message.body.data.summary
}
declare const approval: Approval
if (approval.kind === "tool_action") {
  approval.requestedAction.resourceRefs
} else {
  // @ts-expect-error human approval cannot include a tool action
  approval.requestedAction
}
declare const request: CreateRunRequest
request.requestedCapabilities satisfies string[]
// @ts-expect-error server-resolved grants are not a public create-run field
request.grant
// @ts-expect-error a runtime attempt is not a caller supplied field
request.attemptId
declare const group: Group
// @ts-expect-error Group does not permanently identify an IM group or Thread
group.localThreadId
declare const bot: Bot
// @ts-expect-error Bot is not a Runtime node
bot.runtimeNodeId
const queued: RunStatus = "queued"
void queued
// @ts-expect-error enums derive from the single state table
const incorrect: RunStatus = "done"
void incorrect
