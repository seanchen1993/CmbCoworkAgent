// Generated offline from contracts/bot/v1/*.json. DO NOT EDIT.
// Structural types only: use the JSON Schema validator for bounds and semantic checks.

export type AcceptedBody = {
  "runId": Id;
  "attemptId": Id;
  "leaseId": Id;
  "fence": Version;
};

export type AckBody = {
  "eventId": Id;
  "runId": Id;
  "attemptId": Id;
  "eventSeq": Version;
};

export type ActiveAttempt = {
  "runId": Id;
  "attemptId": Id;
  "fence": Version;
};

export type Approval = (HumanApproval | ToolApproval);

export type ApprovalDecision = {
  "id": Id;
  "approvalId": Id;
  "spaceId": Id;
  "principalId": Id;
  "decision": Decision;
  "comment"?: Text;
  "inputArtifactVersions": ArtifactRefs;
  "createdAt": UtcDateTime;
};

export type ApprovalDecisionResult = {
  "approval": Approval;
  "decision": ApprovalDecision;
};

export type ApprovalResult = {
  "approval": Approval;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated";

export type Artifact = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "taskId": Id;
  "kind": ArtifactKind;
  "currentVersionId": Id;
};

export type ArtifactCommittedData = {
  "artifact": ArtifactVersionRef;
};

export type ArtifactCommittedEventBody = {
  "eventId": Id;
  "nodeId": Id;
  "runId": Id;
  "attemptId": Id;
  "eventSeq": Version;
  "leaseId": Id;
  "fence": Version;
  "authorizationVersion": Version;
  "occurredAt": UtcDateTime;
  "eventType": "artifact_committed";
  "data": ArtifactCommittedData;
};

export type ArtifactKind = "source" | "prd" | "assessment" | "prototype" | "development_handoff" | "verification";

export type ArtifactRefs = Array<ArtifactVersionRef>;

export type ArtifactResult = {
  "artifact": Artifact;
  "artifactVersion": ArtifactVersion;
};

export type ArtifactVersion = {
  "id": Id;
  "artifactId": Id;
  "spaceId": Id;
  "taskId": Id;
  "number": Version;
  "digest": Digest;
  "mediaType": MediaType;
  "sizeBytes": ByteSize;
  "blobRef": Id;
  "createdAt": UtcDateTime;
  "createdBy": Id;
};

export type ArtifactVersionRef = {
  "artifactId": Id;
  "versionId": Id;
  "digest": Digest;
};

export type ArtifactVersionResult = {
  "artifactVersion": ArtifactVersion;
};

export type AttemptStatus = "dispatched" | "accepted" | "running" | "waiting_approval" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";

export type BinaryContent = string;

export type Bot = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "name": ShortText;
  "status": "active" | "disabled";
  "currentBotVersionId": Id;
  "maintainerIds": Array<Id>;
};

export type BotConfig = {
  "description": Text;
  "instructions": Text;
  "knowledgeRefs": IdList;
  "repositoryRefs": IdList;
  "skillAllowlist": IdList;
  "capabilityCeiling": CapabilityList;
  "memoryPolicy": "disabled" | "explicit_only";
  "persona"?: Text;
};

export type BotResult = {
  "bot": Bot;
  "botVersion": BotVersion;
};

export type BotVersion = {
  "id": Id;
  "botId": Id;
  "spaceId": Id;
  "number": Version;
  "config": BotConfig;
  "createdAt": UtcDateTime;
};

export type Budget = {
  "maxTokens": number;
  "maxDurationSeconds": number;
  "maxToolCalls": number;
};

export type ByteSize = number;

export type CancelBody = {
  "runId": Id;
  "attemptId": Id;
  "leaseId": Id;
  "fence": Version;
  "reason": ShortText;
};

export type CancelRunRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "reason": ShortText;
};

export type Capability = "requirements.analyze" | "repository.read" | "prototype.generate" | "workspace.write" | "command.execute" | "requirements.publish";

export type CapabilityList = Array<Capability>;

export type CompleteUploadRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "digest": Digest;
  "sizeBytes": ByteSize;
};

export type CompletedData = {
  "outcome": "succeeded" | "failed" | "cancelled" | "outcome_unknown";
  "artifactVersions": ArtifactRefs;
  "errorCode"?: ErrorCode;
};

export type CompletedEventBody = {
  "eventId": Id;
  "nodeId": Id;
  "runId": Id;
  "attemptId": Id;
  "eventSeq": Version;
  "leaseId": Id;
  "fence": Version;
  "authorizationVersion": Version;
  "occurredAt": UtcDateTime;
  "eventType": "completed";
  "data": CompletedData;
};

export type CreateApprovalRequest = (CreateHumanApprovalRequest | CreateToolApprovalRequest);

export type CreateArtifactRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "uploadId": Id;
  "kind": ArtifactKind;
};

export type CreateArtifactVersionRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "baseVersionId": Id;
  "uploadId": Id;
  "changeDescription": Text;
};

export type CreateBotRequest = {
  "commandId": Id;
  "name": ShortText;
  "config": BotConfig;
  "maintainerIds": Array<Id>;
};

export type CreateBotVersionRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "config": BotConfig;
};

export type CreateDevelopmentHandoffRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "prd": ArtifactVersionRef;
  "assessment": ArtifactVersionRef;
  "prototype"?: ArtifactVersionRef;
  "repositoryRef": Id;
  "repositoryRevision": ShortText;
  "acceptanceCriteria": Array<Text>;
  "exclusions": TextList;
  "openQuestions": TextList;
  "businessApprovalId": Id;
  "technicalApprovalId": Id;
};

export type CreateGroupRequest = {
  "commandId": Id;
  "name": ShortText;
  "bots": GroupBots;
  "members": GroupMembers;
  "limits": GroupLimits;
};

export type CreateHandoffRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "fromBotId": Id;
  "toBotId": Id;
  "inputArtifactVersions": ArtifactRefs;
  "expectedOutput": Text;
  "budget": Budget;
  "deadline": UtcDateTime;
};

export type CreateHumanApprovalRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "kind": "business_scope" | "technical_handoff";
  "inputArtifactVersions": ArtifactRefs;
  "approverIds": Array<Id>;
  "expiresAt": UtcDateTime;
};

export type CreateRunRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "taskId": Id;
  "stageId": Id;
  "botId": Id;
  "mode": ModeRef;
  "inputArtifactVersions": ArtifactRefs;
  "workspaceRef": Id;
  "requestedCapabilities": Array<Capability>;
  "approvalIds": IdList;
  "budget": Budget;
  "deadline": UtcDateTime;
};

export type CreateTaskMessageRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "text": Text;
  "artifactVersions": ArtifactRefs;
  "targetBotId"?: Id;
};

export type CreateTaskRequest = {
  "commandId": Id;
  "groupId": Id;
  "title": ShortText;
  "goal": Text;
  "inputArtifactVersions": ArtifactRefs;
};

export type CreateToolApprovalRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "kind": "tool_action";
  "inputArtifactVersions": ArtifactRefs;
  "requestedAction": RequestedAction;
  "approverIds": Array<Id>;
  "expiresAt": UtcDateTime;
};

export type CreateUploadRequest = {
  "commandId": Id;
  "taskId": Id;
  "purpose": ArtifactKind;
  "fileName": FileName;
  "mediaType": MediaType;
  "sizeBytes": ByteSize;
  "digest": Digest;
};

export type CredentialBinding = {
  "credentialRef": Id;
  "purpose": "requirement_read" | "requirement_publish" | "repository_read" | "repository_write";
};

export type Cursor = string;

export type DecideApprovalRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "decision": Decision;
  "comment"?: Text;
  "inputArtifactVersions": ArtifactRefs;
};

export type Decision = "approve" | "reject";

export type Delivery = {
  "id": Id;
  "spaceId": Id;
  "runId": Id;
  "attemptId"?: Id;
  "eventId": Id;
  "destinationRef": Id;
  "status": DeliveryStatus;
  "attempts": number;
};

export type DeliveryStatus = "pending" | "accepted" | "delivered" | "failed" | "outcome_unknown";

export type DevelopmentHandoff = {
  "id": Id;
  "spaceId": Id;
  "taskId": Id;
  "commandId": Id;
  "prd": ArtifactVersionRef;
  "assessment": ArtifactVersionRef;
  "prototype"?: ArtifactVersionRef;
  "repositoryRef": Id;
  "repositoryRevision": ShortText;
  "acceptanceCriteria": Array<Text>;
  "exclusions": TextList;
  "openQuestions": TextList;
  "businessApprovalId": Id;
  "technicalApprovalId": Id;
  "createdAt": UtcDateTime;
};

export type DevelopmentHandoffResult = {
  "handoff": DevelopmentHandoff;
};

export type Digest = string;

export type EntityMeta = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
};

export type EntityRef = {
  "kind": "bot" | "group" | "task" | "artifact" | "approval" | "run" | "delivery";
  "id": Id;
  "version": Version;
};

export type ErrorCode = "INVALID_PAYLOAD" | "SCHEMA_VERSION_UNSUPPORTED" | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "VERSION_CONFLICT" | "COMMAND_CONFLICT" | "COMMAND_EXPIRED" | "INPUT_CHANGED" | "APPROVAL_REQUIRED" | "APPROVAL_EXPIRED" | "NODE_OFFLINE" | "CAPABILITY_UNAVAILABLE" | "OUTCOME_UNKNOWN" | "CURSOR_EXPIRED" | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED" | "DEPENDENCY_UNAVAILABLE";

export type ErrorResponse = {
  "requestId": Id;
  "error": {
  "code": ErrorCode;
  "message": string;
  "retryable": boolean;
  "currentVersion"?: Version;
  "retryAfterSeconds"?: number;
};
};

export type Event = {
  "eventId": Id;
  "spaceId": Id;
  "seq": Version;
  "occurredAt": UtcDateTime;
  "kind": "task_updated" | "artifact_committed" | "approval_updated" | "run_updated" | "delivery_updated";
  "taskId"?: Id;
  "runId"?: Id;
  "entityRef": EntityRef;
};

export type EventHighWater = number;

export type EventLimit = number;

export type EventsResult = {
  "events": Array<Event>;
  "nextCursor": Cursor;
  "hasMore": boolean;
};

export type FileName = string;

export type GrantRef = {
  "grantId": Id;
  "version": Version;
};

export type Group = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "name": ShortText;
  "bots": GroupBots;
  "members": GroupMembers;
  "limits": GroupLimits;
};

export type GroupBot = {
  "botId": Id;
  "botVersionId": Id;
  "role": "coordinator" | "specialist";
};

export type GroupBots = Array<GroupBot>;

export type GroupLimits = {
  "maxHandoffs": number;
  "maxRuns": number;
  "maxTokens": number;
};

export type GroupMember = {
  "principalId": Id;
  "role": "admin" | "participant" | "business_owner" | "technical_owner";
};

export type GroupMembers = Array<GroupMember>;

export type GroupResult = {
  "group": Group;
};

export type Handoff = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "taskId": Id;
  "fromBotId": Id;
  "toBotId": Id;
  "inputArtifactVersions": ArtifactRefs;
  "expectedOutput": Text;
  "status": HandoffStatus;
  "budget": Budget;
  "deadline": UtcDateTime;
};

export type HandoffResult = {
  "handoff": Handoff;
};

export type HandoffStatus = "pending" | "accepted" | "running" | "completed" | "rejected" | "cancelled" | "outcome_unknown";

export type HeartbeatBody = {
  "nodeId": Id;
  "connectionId": Id;
  "activeAttempts": Array<ActiveAttempt>;
  "sentAt": UtcDateTime;
};

export type HumanApproval = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "taskId": Id;
  "kind": "business_scope" | "technical_handoff";
  "inputArtifactVersions": ArtifactRefs;
  "approverIds": Array<Id>;
  "status": ApprovalStatus;
  "expiresAt": UtcDateTime;
};

export type Id = string;

export type IdList = Array<Id>;

export type IfMatchVersion = string;

export type InspectBody = {
  "requestId": Id;
  "runId": Id;
  "attemptId": Id;
};

export type InspectionBody = {
  "requestId": Id;
  "runId": Id;
  "attemptId": Id;
  "status": AttemptStatus;
  "lastEventSeq": EventHighWater;
  "fence": Version;
  "checkpointRef"?: Id;
};

export type Lease = {
  "leaseId": Id;
  "fence": Version;
  "expiresAt": UtcDateTime;
  "authorizationVersion": Version;
};

export type MaterialWorkspace = {
  "workspaceRef": Id;
  "isolation": "task";
  "access": "read" | "write";
  "inputArtifactVersions": ArtifactRefs;
};

export type MediaType = string;

export type ModeRef = {
  "id": "requirement" | "assessment" | "prototype" | "project";
  "version": 1;
};

export type PrepareWorkspaceBody = {
  "requestId": Id;
  "runId": Id;
  "attemptId": Id;
  "workspace": WorkspaceSpec;
  "grant": GrantRef;
  "lease": Lease;
};

export type ProgressData = {
  "summary": ShortText;
};

export type ProgressEventBody = {
  "eventId": Id;
  "nodeId": Id;
  "runId": Id;
  "attemptId": Id;
  "eventSeq": Version;
  "leaseId": Id;
  "fence": Version;
  "authorizationVersion": Version;
  "occurredAt": UtcDateTime;
  "eventType": "progress";
  "data": ProgressData;
};

export type ProjectBinding = {
  "handoffId": Id;
  "provider": ProviderId;
  "projectId": Id;
  "featureRef"?: Id;
  "localThreadId"?: Id;
  "createdAt": UtcDateTime;
};

export type Provider = "desktop" | "hosted";

export type ProviderId = Id;

export type RegisterBody = {
  "nodeId": Id;
  "provider": Provider;
  "capabilities": RuntimeCapabilities;
};

export type RegisteredBody = {
  "nodeId": Id;
  "connectionId": Id;
  "heartbeatIntervalSeconds": number;
  "serverTime": UtcDateTime;
};

export type RepositoryWorkspace = {
  "workspaceRef": Id;
  "isolation": "task";
  "access": "read" | "write";
  "repositoryRef": Id;
  "repositoryRevision": ShortText;
  "inputArtifactVersions": ArtifactRefs;
};

export type RequestedAction = {
  "capability": Capability;
  "resourceRefs": IdList;
  "inputDigest": Digest;
};

export type ResumeBody = {
  "run": RunSpec;
  "lease": Lease;
  "checkpointRef": Id;
};

export type Run = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "taskId": Id;
  "stageId": Id;
  "botVersionId": Id;
  "mode": ModeRef;
  "inputArtifactVersions": ArtifactRefs;
  "status": RunStatus;
  "activeAttemptId"?: Id;
  "requesterPrincipalId": Id;
  "budget": Budget;
  "deadline": UtcDateTime;
};

export type RunAttempt = {
  "id": Id;
  "spaceId": Id;
  "runId": Id;
  "number": Version;
  "runtimeNodeId": Id;
  "status": AttemptStatus;
  "lease": Lease;
  "startedAt"?: UtcDateTime;
  "finishedAt"?: UtcDateTime;
  "checkpointRef"?: Id;
};

export type RunDetailResult = {
  "run": Run;
  "attempts": Array<RunAttempt>;
};

export type RunResult = {
  "run": Run;
};

export type RunSpec = {
  "schemaVersion": 1;
  "runId": Id;
  "attemptId": Id;
  "taskId": Id;
  "stageId": Id;
  "botVersionId": Id;
  "mode": ModeRef;
  "contextManifestRef": Id;
  "inputArtifactVersions": ArtifactRefs;
  "workspace": WorkspaceSpec;
  "grant": GrantRef;
  "credentialBindings": Array<CredentialBinding>;
  "approvalIds": IdList;
  "budget": Budget;
  "deadline": UtcDateTime;
};

export type RunStatus = "queued" | "waiting_node" | "starting" | "running" | "waiting_approval" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";

export type RuntimeCapabilities = {
  "modes": Array<ModeRef>;
  "capabilities": CapabilityList;
  "recovery": "same_node_checkpoint" | "none";
  "maxConcurrentRuns": number;
};

export type RuntimeEnvelope = ({
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "register";
  "body": RegisterBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "registered";
  "body": RegisteredBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "heartbeat";
  "body": HeartbeatBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "prepare_workspace";
  "body": PrepareWorkspaceBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "workspace_prepared";
  "body": WorkspacePreparedBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "start";
  "body": StartBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "accepted";
  "body": AcceptedBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "cancel";
  "body": CancelBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "inspect";
  "body": InspectBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "inspection";
  "body": InspectionBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "resume";
  "body": ResumeBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "event";
  "body": RuntimeEventBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "ack";
  "body": AckBody;
} | {
  "protocol": "devclaw.bot.runtime";
  "schemaVersion": 1;
  "messageId": Id;
  "type": "error";
  "body": RuntimeErrorBody;
});

export type RuntimeErrorBody = {
  "requestId": Id;
  "code": ErrorCode;
  "message": ShortText;
  "retryable": boolean;
};

export type RuntimeEventBody = (ProgressEventBody | WaitingApprovalEventBody | ArtifactCommittedEventBody | CompletedEventBody);

export type RuntimeNode = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "provider": Provider;
  "status": "online" | "offline" | "draining" | "disabled";
  "capabilities": RuntimeCapabilities;
  "lastSeenAt": UtcDateTime;
};

export type ShortText = string;

export type Stage = {
  "id": Id;
  "kind": StageKind;
  "status": StageStatus;
  "inputArtifactVersions": ArtifactRefs;
  "outputArtifactVersions": ArtifactRefs;
};

export type StageKind = "requirement" | "assessment" | "prototype" | "scope_confirmation" | "development";

export type StageStatus = "pending" | "active" | "waiting_confirmation" | "completed" | "cancelled";

export type StartBody = {
  "run": RunSpec;
  "lease": Lease;
};

export type Task = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "groupId": Id;
  "taskNumber": ShortText;
  "title": ShortText;
  "goal": Text;
  "status": TaskStatus;
  "currentStageId": Id;
  "stages": Array<Stage>;
  "inputArtifactVersions": ArtifactRefs;
};

export type TaskMessage = {
  "id": Id;
  "spaceId": Id;
  "taskId": Id;
  "authorPrincipalId": Id;
  "text": Text;
  "artifactVersions": ArtifactRefs;
  "createdAt": UtcDateTime;
};

export type TaskMessageResult = {
  "message": TaskMessage;
  "taskVersion": Version;
};

export type TaskResult = {
  "task": Task;
};

export type TaskSnapshotResult = {
  "task": Task;
  "snapshotCursor": Cursor;
};

export type TaskStatus = "draft" | "active" | "awaiting_business" | "awaiting_technical" | "handed_off" | "completed" | "cancelled";

export type Text = string;

export type TextList = Array<Text>;

export type ThreadBinding = {
  "spaceId": Id;
  "taskId": Id;
  "stageId": Id;
  "runtimeNodeId": Id;
  "provider": ProviderId;
  "localThreadId": Id;
};

export type ToolApproval = {
  "id": Id;
  "spaceId": Id;
  "version": Version;
  "createdAt": UtcDateTime;
  "updatedAt": UtcDateTime;
  "taskId": Id;
  "kind": "tool_action";
  "inputArtifactVersions": ArtifactRefs;
  "requestedAction": RequestedAction;
  "approverIds": Array<Id>;
  "status": ApprovalStatus;
  "expiresAt": UtcDateTime;
};

export type TransitionStageRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "toStage": StageKind;
  "inputArtifactVersions": ArtifactRefs;
  "approvalIds": IdList;
};

export type UpdateGroupMembersRequest = {
  "commandId": Id;
  "expectedVersion": Version;
  "bots": GroupBots;
  "members": GroupMembers;
};

export type UploadContentHeaders = {
  "X-DevClaw-Space": Id;
  "X-Command-Id": Id;
  "If-Match": IfMatchVersion;
  "Content-Type": MediaType;
};

export type UploadResult = {
  "upload": UploadSession;
};

export type UploadSession = {
  "id": Id;
  "spaceId": Id;
  "taskId": Id;
  "version": Version;
  "purpose": ArtifactKind;
  "fileName": FileName;
  "mediaType": MediaType;
  "sizeBytes": ByteSize;
  "digest": Digest;
  "status": UploadStatus;
  "expiresAt": UtcDateTime;
};

export type UploadStatus = "created" | "uploading" | "verifying" | "committed" | "rejected" | "expired";

export type UtcDateTime = string;

export type Version = number;

export type WaitingApprovalData = {
  "approvalId": Id;
};

export type WaitingApprovalEventBody = {
  "eventId": Id;
  "nodeId": Id;
  "runId": Id;
  "attemptId": Id;
  "eventSeq": Version;
  "leaseId": Id;
  "fence": Version;
  "authorizationVersion": Version;
  "occurredAt": UtcDateTime;
  "eventType": "waiting_approval";
  "data": WaitingApprovalData;
};

export type WorkspacePreparedBody = {
  "requestId": Id;
  "runId": Id;
  "attemptId": Id;
  "workspaceRef": Id;
  "inputDigest": Digest;
};

export type WorkspaceSpec = (MaterialWorkspace | RepositoryWorkspace);
