// Generated offline by scripts/generate-bot-java-contracts.mjs. DO NOT EDIT.
// Exact source SHA-256: 0d2a92e78e0299aa09f9c0d8e137a062bc3d0f73405bb617092834e50a16efb3
// Structural DTOs only; original Schema bounds, required/null and if/then need runtime validation.
// Reachable definitions: schemas.json#/$defs/Bot, schemas.json#/$defs/BotConfig, schemas.json#/$defs/BotResult, schemas.json#/$defs/BotVersion, schemas.json#/$defs/Capability, schemas.json#/$defs/CapabilityList, schemas.json#/$defs/CreateBotRequest, schemas.json#/$defs/CreateBotVersionRequest, schemas.json#/$defs/CreateGroupRequest, schemas.json#/$defs/ErrorCode, schemas.json#/$defs/ErrorResponse, schemas.json#/$defs/Group, schemas.json#/$defs/GroupBot, schemas.json#/$defs/GroupBots, schemas.json#/$defs/GroupLimits, schemas.json#/$defs/GroupMember, schemas.json#/$defs/GroupMembers, schemas.json#/$defs/GroupResult, schemas.json#/$defs/Id, schemas.json#/$defs/IdList, schemas.json#/$defs/ShortText, schemas.json#/$defs/Text, schemas.json#/$defs/UpdateGroupMembersRequest, schemas.json#/$defs/UtcDateTime, schemas.json#/$defs/Version
package com.devclaw.botcontrol.contracts;

import java.util.List;
import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonValue;

public final class BotContracts {
    private BotContracts() {}

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
        // GET /api/bot/v1/bots/{botId}; error: ErrorResponse
        BotResult getBot(String xDevClawSpace, String botId);
        // GET /api/bot/v1/groups/{groupId}; error: ErrorResponse
        GroupResult getGroup(String xDevClawSpace, String groupId);
        // PUT /api/bot/v1/groups/{groupId}/members; error: ErrorResponse
        GroupResult updateGroupMembers(String xDevClawSpace, String groupId, UpdateGroupMembersRequest body);
    }
}
