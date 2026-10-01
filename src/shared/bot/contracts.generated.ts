// Generated offline from contracts/bot/v1/*.json. DO NOT EDIT.
// Structural types only: use the JSON Schema validator for bounds and semantic checks.

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated";

export type ArtifactKind = "source" | "prd" | "assessment" | "prototype" | "development_handoff" | "verification";

export type ArtifactRefs = Array<ArtifactVersionRef>;

export type ArtifactVersionRef = {
  "artifactId": Id;
  "versionId": Id;
  "digest": Digest;
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

export type Capability = "requirements.analyze" | "repository.read" | "prototype.generate" | "workspace.write" | "command.execute" | "requirements.publish";

export type CapabilityList = Array<Capability>;

export type CredentialBinding = {
  "credentialRef": Id;
  "purpose": "requirement_read" | "requirement_publish" | "repository_read" | "repository_write";
};

export type Cursor = string;

export type DeliveryStatus = "pending" | "accepted" | "delivered" | "failed" | "outcome_unknown";

export type Digest = string;

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

export type EventHighWater = number;

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

export type HandoffStatus = "pending" | "accepted" | "running" | "completed" | "rejected" | "cancelled" | "outcome_unknown";

export type Id = string;

export type IdList = Array<Id>;

export type ModeRef = {
  "id": "requirement" | "assessment" | "prototype" | "project";
  "version": 1;
};

export type Provider = "desktop" | "hosted";

export type ProviderId = Id;

export type RunStatus = "queued" | "waiting_node" | "starting" | "running" | "waiting_approval" | "cancel_requested" | "succeeded" | "failed" | "cancelled" | "outcome_unknown";

export type ShortText = string;

export type StageKind = "requirement" | "assessment" | "prototype" | "scope_confirmation" | "development";

export type StageStatus = "pending" | "active" | "waiting_confirmation" | "completed" | "cancelled";

export type TaskStatus = "draft" | "active" | "awaiting_business" | "awaiting_technical" | "handed_off" | "completed" | "cancelled";

export type Text = string;

export type UploadStatus = "created" | "uploading" | "verifying" | "committed" | "rejected" | "expired";

export type UtcDateTime = string;

export type Version = number;
