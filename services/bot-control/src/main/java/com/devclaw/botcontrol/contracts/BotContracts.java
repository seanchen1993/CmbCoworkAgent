// Generated offline by scripts/generate-bot-java-contracts.mjs. DO NOT EDIT.
// Exact source SHA-256: 18085a4434be737f620ab22f3ef16bfed37ec1ccc74545436586ebd0ee755cc1
// Structural DTOs only; original Schema bounds, required/null and if/then need runtime validation.
// Reachable definitions: schemas.json#/$defs/ArtifactRefs, schemas.json#/$defs/ArtifactVersionRef, schemas.json#/$defs/Bot, schemas.json#/$defs/BotConfig, schemas.json#/$defs/BotResult, schemas.json#/$defs/BotVersion, schemas.json#/$defs/Capability, schemas.json#/$defs/CapabilityList, schemas.json#/$defs/CreateBotRequest, schemas.json#/$defs/CreateBotVersionRequest, schemas.json#/$defs/CreateGroupRequest, schemas.json#/$defs/CreateTaskMessageRequest, schemas.json#/$defs/CreateTaskRequest, schemas.json#/$defs/Cursor, schemas.json#/$defs/Digest, schemas.json#/$defs/EntityRef, schemas.json#/$defs/ErrorCode, schemas.json#/$defs/ErrorResponse, schemas.json#/$defs/Event, schemas.json#/$defs/EventLimit, schemas.json#/$defs/EventsResult, schemas.json#/$defs/Group, schemas.json#/$defs/GroupBot, schemas.json#/$defs/GroupBots, schemas.json#/$defs/GroupLimits, schemas.json#/$defs/GroupMember, schemas.json#/$defs/GroupMembers, schemas.json#/$defs/GroupResult, schemas.json#/$defs/Id, schemas.json#/$defs/IdList, schemas.json#/$defs/ShortText, schemas.json#/$defs/Stage, schemas.json#/$defs/StageKind, schemas.json#/$defs/Task, schemas.json#/$defs/TaskMessage, schemas.json#/$defs/TaskMessageResult, schemas.json#/$defs/TaskResult, schemas.json#/$defs/TaskSnapshotResult, schemas.json#/$defs/Text, schemas.json#/$defs/UpdateGroupMembersRequest, schemas.json#/$defs/UtcDateTime, schemas.json#/$defs/Version, state-transitions.json#/$defs/StageStatus, state-transitions.json#/$defs/TaskStatus
package com.devclaw.botcontrol.contracts;

import java.util.List;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonValue;

public final class BotContracts {
    private BotContracts() {}

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ArtifactVersionRef {
        @JsonProperty(value = "artifactId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String artifactId;
        @JsonProperty(value = "versionId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String versionId;
        @JsonProperty(value = "digest", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String digest;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Bot {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "version", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long version;
        @JsonProperty(value = "createdAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String createdAt;
        @JsonProperty(value = "updatedAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String updatedAt;
        @JsonProperty(value = "name", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String name;
        @JsonProperty(value = "status", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotStatus status;
        @JsonProperty(value = "currentBotVersionId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String currentBotVersionId;
        @JsonProperty(value = "maintainerIds", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<String> maintainerIds;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class BotConfig {
        @JsonProperty(value = "description", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String description;
        @JsonProperty(value = "instructions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String instructions;
        @JsonProperty(value = "knowledgeRefs", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<String> knowledgeRefs;
        @JsonProperty(value = "repositoryRefs", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<String> repositoryRefs;
        @JsonProperty(value = "skillAllowlist", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<String> skillAllowlist;
        @JsonProperty(value = "capabilityCeiling", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<Capability> capabilityCeiling;
        @JsonProperty(value = "memoryPolicy", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotConfigMemoryPolicy memoryPolicy;
        @JsonProperty(value = "persona", required = false)
        public String persona;
    }

    public enum BotConfigMemoryPolicy {
        DISABLED("disabled"),
        EXPLICIT_ONLY("explicit_only");
        private final String wire;
        BotConfigMemoryPolicy(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static BotConfigMemoryPolicy fromWire(String wire) {
            for (BotConfigMemoryPolicy value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown BotConfigMemoryPolicy wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class BotResult {
        @JsonProperty(value = "bot", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Bot bot;
        @JsonProperty(value = "botVersion", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotVersion botVersion;
    }

    public enum BotStatus {
        ACTIVE("active"),
        DISABLED("disabled");
        private final String wire;
        BotStatus(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static BotStatus fromWire(String wire) {
            for (BotStatus value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown BotStatus wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class BotVersion {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "botId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String botId;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "number", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long number;
        @JsonProperty(value = "config", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotConfig config;
        @JsonProperty(value = "createdAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String createdAt;
    }

    public enum Capability {
        REQUIREMENTS_ANALYZE("requirements.analyze"),
        REPOSITORY_READ("repository.read"),
        PROTOTYPE_GENERATE("prototype.generate"),
        WORKSPACE_WRITE("workspace.write"),
        COMMAND_EXECUTE("command.execute"),
        REQUIREMENTS_PUBLISH("requirements.publish");
        private final String wire;
        Capability(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static Capability fromWire(String wire) {
            for (Capability value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown Capability wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class CreateBotRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "name", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String name;
        @JsonProperty(value = "config", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotConfig config;
        @JsonProperty(value = "maintainerIds", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<String> maintainerIds;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class CreateBotVersionRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "expectedVersion", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long expectedVersion;
        @JsonProperty(value = "config", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public BotConfig config;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class CreateGroupRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "name", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String name;
        @JsonProperty(value = "bots", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupBot> bots;
        @JsonProperty(value = "members", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupMember> members;
        @JsonProperty(value = "limits", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public GroupLimits limits;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class CreateTaskMessageRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "expectedVersion", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long expectedVersion;
        @JsonProperty(value = "text", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String text;
        @JsonProperty(value = "artifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> artifactVersions;
        @JsonProperty(value = "targetBotId", required = false)
        public String targetBotId;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class CreateTaskRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "groupId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String groupId;
        @JsonProperty(value = "title", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String title;
        @JsonProperty(value = "goal", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String goal;
        @JsonProperty(value = "inputArtifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> inputArtifactVersions;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class EntityRef {
        @JsonProperty(value = "kind", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public EntityRefKind kind;
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "version", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long version;
    }

    public enum EntityRefKind {
        BOT("bot"),
        GROUP("group"),
        TASK("task"),
        ARTIFACT("artifact"),
        APPROVAL("approval"),
        RUN("run"),
        DELIVERY("delivery");
        private final String wire;
        EntityRefKind(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static EntityRefKind fromWire(String wire) {
            for (EntityRefKind value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown EntityRefKind wire value");
        }
    }

    public enum ErrorCode {
        INVALID_PAYLOAD("INVALID_PAYLOAD"),
        SCHEMA_VERSION_UNSUPPORTED("SCHEMA_VERSION_UNSUPPORTED"),
        UNAUTHENTICATED("UNAUTHENTICATED"),
        FORBIDDEN("FORBIDDEN"),
        NOT_FOUND("NOT_FOUND"),
        VERSION_CONFLICT("VERSION_CONFLICT"),
        COMMAND_CONFLICT("COMMAND_CONFLICT"),
        COMMAND_EXPIRED("COMMAND_EXPIRED"),
        INPUT_CHANGED("INPUT_CHANGED"),
        APPROVAL_REQUIRED("APPROVAL_REQUIRED"),
        APPROVAL_EXPIRED("APPROVAL_EXPIRED"),
        NODE_OFFLINE("NODE_OFFLINE"),
        CAPABILITY_UNAVAILABLE("CAPABILITY_UNAVAILABLE"),
        OUTCOME_UNKNOWN("OUTCOME_UNKNOWN"),
        CURSOR_EXPIRED("CURSOR_EXPIRED"),
        PAYLOAD_TOO_LARGE("PAYLOAD_TOO_LARGE"),
        RATE_LIMITED("RATE_LIMITED"),
        DEPENDENCY_UNAVAILABLE("DEPENDENCY_UNAVAILABLE");
        private final String wire;
        ErrorCode(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static ErrorCode fromWire(String wire) {
            for (ErrorCode value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown ErrorCode wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ErrorResponse {
        @JsonProperty(value = "requestId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String requestId;
        @JsonProperty(value = "error", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public ErrorResponseError error;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class ErrorResponseError {
        @JsonProperty(value = "code", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public ErrorCode code;
        @JsonProperty(value = "message", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String message;
        @JsonProperty(value = "retryable", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Boolean retryable;
        @JsonProperty(value = "currentVersion", required = false)
        public Long currentVersion;
        @JsonProperty(value = "retryAfterSeconds", required = false)
        public Long retryAfterSeconds;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Event {
        @JsonProperty(value = "eventId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String eventId;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "seq", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long seq;
        @JsonProperty(value = "occurredAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String occurredAt;
        @JsonProperty(value = "kind", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public EventKind kind;
        @JsonProperty(value = "taskId", required = false)
        public String taskId;
        @JsonProperty(value = "runId", required = false)
        public String runId;
        @JsonProperty(value = "entityRef", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public EntityRef entityRef;
    }

    public enum EventKind {
        TASK_UPDATED("task_updated"),
        ARTIFACT_COMMITTED("artifact_committed"),
        APPROVAL_UPDATED("approval_updated"),
        RUN_UPDATED("run_updated"),
        DELIVERY_UPDATED("delivery_updated");
        private final String wire;
        EventKind(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static EventKind fromWire(String wire) {
            for (EventKind value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown EventKind wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class EventsResult {
        @JsonProperty(value = "events", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<Event> events;
        @JsonProperty(value = "nextCursor", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String nextCursor;
        @JsonProperty(value = "hasMore", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Boolean hasMore;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Group {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "version", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long version;
        @JsonProperty(value = "createdAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String createdAt;
        @JsonProperty(value = "updatedAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String updatedAt;
        @JsonProperty(value = "name", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String name;
        @JsonProperty(value = "bots", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupBot> bots;
        @JsonProperty(value = "members", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupMember> members;
        @JsonProperty(value = "limits", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public GroupLimits limits;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class GroupBot {
        @JsonProperty(value = "botId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String botId;
        @JsonProperty(value = "botVersionId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String botVersionId;
        @JsonProperty(value = "role", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public GroupBotRole role;
    }

    public enum GroupBotRole {
        COORDINATOR("coordinator"),
        SPECIALIST("specialist");
        private final String wire;
        GroupBotRole(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static GroupBotRole fromWire(String wire) {
            for (GroupBotRole value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown GroupBotRole wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class GroupLimits {
        @JsonProperty(value = "maxHandoffs", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long maxHandoffs;
        @JsonProperty(value = "maxRuns", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long maxRuns;
        @JsonProperty(value = "maxTokens", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long maxTokens;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class GroupMember {
        @JsonProperty(value = "principalId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String principalId;
        @JsonProperty(value = "role", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public GroupMemberRole role;
    }

    public enum GroupMemberRole {
        ADMIN("admin"),
        PARTICIPANT("participant"),
        BUSINESS_OWNER("business_owner"),
        TECHNICAL_OWNER("technical_owner");
        private final String wire;
        GroupMemberRole(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static GroupMemberRole fromWire(String wire) {
            for (GroupMemberRole value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown GroupMemberRole wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class GroupResult {
        @JsonProperty(value = "group", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Group group;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Stage {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "kind", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public StageKind kind;
        @JsonProperty(value = "status", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public StageStatus status;
        @JsonProperty(value = "inputArtifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> inputArtifactVersions;
        @JsonProperty(value = "outputArtifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> outputArtifactVersions;
    }

    public enum StageKind {
        REQUIREMENT("requirement"),
        ASSESSMENT("assessment"),
        PROTOTYPE("prototype"),
        SCOPE_CONFIRMATION("scope_confirmation"),
        DEVELOPMENT("development");
        private final String wire;
        StageKind(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static StageKind fromWire(String wire) {
            for (StageKind value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown StageKind wire value");
        }
    }

    public enum StageStatus {
        PENDING("pending"),
        ACTIVE("active"),
        WAITING_CONFIRMATION("waiting_confirmation"),
        COMPLETED("completed"),
        CANCELLED("cancelled");
        private final String wire;
        StageStatus(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static StageStatus fromWire(String wire) {
            for (StageStatus value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown StageStatus wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class Task {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "version", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long version;
        @JsonProperty(value = "createdAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String createdAt;
        @JsonProperty(value = "updatedAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String updatedAt;
        @JsonProperty(value = "groupId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String groupId;
        @JsonProperty(value = "taskNumber", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String taskNumber;
        @JsonProperty(value = "title", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String title;
        @JsonProperty(value = "goal", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String goal;
        @JsonProperty(value = "status", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public TaskStatus status;
        @JsonProperty(value = "currentStageId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String currentStageId;
        @JsonProperty(value = "stages", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<Stage> stages;
        @JsonProperty(value = "inputArtifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> inputArtifactVersions;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class TaskMessage {
        @JsonProperty(value = "id", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String id;
        @JsonProperty(value = "spaceId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String spaceId;
        @JsonProperty(value = "taskId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String taskId;
        @JsonProperty(value = "authorPrincipalId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String authorPrincipalId;
        @JsonProperty(value = "text", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String text;
        @JsonProperty(value = "artifactVersions", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<ArtifactVersionRef> artifactVersions;
        @JsonProperty(value = "createdAt", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String createdAt;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class TaskMessageResult {
        @JsonProperty(value = "message", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public TaskMessage message;
        @JsonProperty(value = "taskVersion", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long taskVersion;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class TaskResult {
        @JsonProperty(value = "task", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Task task;
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class TaskSnapshotResult {
        @JsonProperty(value = "task", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Task task;
        @JsonProperty(value = "snapshotCursor", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String snapshotCursor;
    }

    public enum TaskStatus {
        DRAFT("draft"),
        ACTIVE("active"),
        AWAITING_BUSINESS("awaiting_business"),
        AWAITING_TECHNICAL("awaiting_technical"),
        HANDED_OFF("handed_off"),
        COMPLETED("completed"),
        CANCELLED("cancelled");
        private final String wire;
        TaskStatus(String wire) { this.wire = wire; }
        @JsonValue public String wire() { return wire; }
        @JsonCreator public static TaskStatus fromWire(String wire) {
            for (TaskStatus value : values()) if (value.wire.equals(wire)) return value;
            throw new IllegalArgumentException("Unknown TaskStatus wire value");
        }
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public static final class UpdateGroupMembersRequest {
        @JsonProperty(value = "commandId", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public String commandId;
        @JsonProperty(value = "expectedVersion", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public Long expectedVersion;
        @JsonProperty(value = "bots", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupBot> bots;
        @JsonProperty(value = "members", required = true)
        @JsonInclude(JsonInclude.Include.ALWAYS)
        public List<GroupMember> members;
    }

    // Typed consumer port only; no server, implementation or authorization implied.
    public interface Operations {
        // POST /api/bot/v1/bots; error: ErrorResponse
        BotResult createBot(String xDevClawSpace, CreateBotRequest body);
        // POST /api/bot/v1/bots/{botId}/versions; error: ErrorResponse
        BotResult createBotVersion(String xDevClawSpace, String botId, CreateBotVersionRequest body);
        // POST /api/bot/v1/groups; error: ErrorResponse
        GroupResult createGroup(String xDevClawSpace, CreateGroupRequest body);
        // POST /api/bot/v1/tasks; error: ErrorResponse
        TaskResult createTask(String xDevClawSpace, CreateTaskRequest body);
        // POST /api/bot/v1/tasks/{taskId}/messages; error: ErrorResponse
        TaskMessageResult createTaskMessage(String xDevClawSpace, String taskId, CreateTaskMessageRequest body);
        // GET /api/bot/v1/bots/{botId}; error: ErrorResponse
        BotResult getBot(String xDevClawSpace, String botId);
        // GET /api/bot/v1/events; error: ErrorResponse
        EventsResult getEvents(String xDevClawSpace, String after, Long limit);
        // GET /api/bot/v1/groups/{groupId}; error: ErrorResponse
        GroupResult getGroup(String xDevClawSpace, String groupId);
        // GET /api/bot/v1/tasks/{taskId}; error: ErrorResponse
        TaskSnapshotResult getTask(String xDevClawSpace, String taskId);
        // PUT /api/bot/v1/groups/{groupId}/members; error: ErrorResponse
        GroupResult updateGroupMembers(String xDevClawSpace, String groupId, UpdateGroupMembersRequest body);
    }
}
