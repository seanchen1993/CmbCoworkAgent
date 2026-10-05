package com.devclaw.botcontrol;

import com.devclaw.botcontrol.contracts.BotContracts;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ContractConsumptionTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test void typedCreateAndGroupConsumersCompileAndSerialize() throws Exception {
        BotConfig config = new BotConfig();
        config.description = "伙伴中文😀";
        config.instructions = "instructions";
        config.knowledgeRefs = Arrays.asList("knowledge1");
        config.repositoryRefs = Arrays.asList("repo1");
        config.skillAllowlist = Arrays.asList("skill1");
        config.capabilityCeiling = Arrays.asList(Capability.REPOSITORY_READ, Capability.WORKSPACE_WRITE);
        config.memoryPolicy = BotConfigMemoryPolicy.EXPLICIT_ONLY;
        CreateBotRequest create = new CreateBotRequest();
        create.commandId = "create1"; create.name = "伙伴"; create.config = config;
        create.maintainerIds = Arrays.asList("principal1");
        CreateBotRequest parsed = json.readValue(json.writeValueAsBytes(create), CreateBotRequest.class);
        assertEquals(config.description, parsed.config.description);
        assertEquals(Capability.REPOSITORY_READ, parsed.config.capabilityCeiling.get(0));
        GroupMember member = new GroupMember();
        member.principalId = "principal1"; member.role = GroupMemberRole.BUSINESS_OWNER;
        GroupBot bot = new GroupBot();
        bot.botId = "bot1"; bot.botVersionId = "version1"; bot.role = GroupBotRole.SPECIALIST;
        GroupLimits limits = new GroupLimits(); limits.maxHandoffs = 1L; limits.maxRuns = 2L; limits.maxTokens = 3L;
        CreateGroupRequest group = new CreateGroupRequest();
        group.commandId = "group1"; group.name = "团队"; group.members = Arrays.asList(member);
        group.bots = Arrays.asList(bot); group.limits = limits;
        CreateGroupRequest decoded = json.readValue(json.writeValueAsBytes(group), CreateGroupRequest.class);
        assertEquals(GroupMemberRole.BUSINESS_OWNER, decoded.members.get(0).role);
        assertEquals(GroupBotRole.SPECIALIST, decoded.bots.get(0).role);
        assertEquals(Long.valueOf(3), decoded.limits.maxTokens);
    }

    @Test void everyEnumRetainsItsWireValueInBothDirections() throws Exception {
        int enums = 0;
        for (Class<?> type : BotContracts.class.getDeclaredClasses()) {
            if (!type.isEnum()) continue;
            enums++;
            for (Object value : type.getEnumConstants()) {
                String wire = (String) type.getMethod("wire").invoke(value);
                assertEquals(wire, json.readTree(json.writeValueAsBytes(value)).textValue());
                assertEquals(value, json.readValue(json.writeValueAsBytes(wire), type));
            }
        }
        assertEquals(6, enums); // Capability, ErrorCode and four inline enum definitions.
        assertThrows(Exception.class, () -> json.readValue("\"REPOSITORY_READ\"", Capability.class));
    }

    @Test void optionalFieldsOmittedButFalseAndPresentValuesRetained() throws Exception {
        BotConfig config = new BotConfig();
        assertFalse(json.readTree(json.writeValueAsBytes(config)).has("persona"));
        config.persona = "persona";
        assertEquals("persona", json.readTree(json.writeValueAsBytes(config)).get("persona").textValue());
        ErrorResponseError error = new ErrorResponseError();
        error.code = ErrorCode.OUTCOME_UNKNOWN; error.message = "Safe error"; error.retryable = false;
        ErrorResponse response = new ErrorResponse(); response.requestId = "request1"; response.error = error;
        JsonNode node = json.readTree(json.writeValueAsBytes(response)).get("error");
        assertFalse(node.get("retryable").booleanValue());
        assertFalse(node.has("currentVersion")); assertFalse(node.has("retryAfterSeconds"));
        error.currentVersion = 9L; error.retryAfterSeconds = 3L;
        node = json.readTree(json.writeValueAsBytes(response)).get("error");
        assertEquals(9L, node.get("currentVersion").longValue());
        assertEquals(3L, node.get("retryAfterSeconds").longValue());
        // Required null remains visible; DTOs are not the original Schema boundary validator.
        assertTrue(json.readTree(json.writeValueAsBytes(config)).get("instructions").isNull());
    }

    @Test void legalSafeIntegerLongPrecisionSurvivesRequestAndResponseRoundTrip() throws Exception {
        long max = 9007199254740991L;
        CreateBotVersionRequest request = json.readValue("{\"commandId\":\"c1\",\"expectedVersion\":9007199254740991}", CreateBotVersionRequest.class);
        assertEquals(Long.valueOf(max), request.expectedVersion);
        assertEquals("9007199254740991", json.readTree(json.writeValueAsBytes(request)).get("expectedVersion").asText());
        Bot bot = new Bot(); bot.version = max; bot.status = BotStatus.ACTIVE;
        BotVersion version = new BotVersion(); version.number = max;
        BotResult result = new BotResult(); result.bot = bot; result.botVersion = version;
        BotResult decoded = json.readValue(json.writeValueAsBytes(result), BotResult.class);
        assertEquals(Long.valueOf(max), decoded.bot.version);
        assertEquals(Long.valueOf(max), decoded.botVersion.number);
        UpdateGroupMembersRequest update = new UpdateGroupMembersRequest(); update.expectedVersion = 4294967296L;
        assertEquals(Long.valueOf(4294967296L), json.readValue(json.writeValueAsBytes(update), UpdateGroupMembersRequest.class).expectedVersion);
    }

    @Test void allSixOperationSignaturesUseFrozenTypedInputsAndOutputs() {
        assertEquals(6, Operations.class.getDeclaredMethods().length);
    }

    // Compile-time consumer of the generated header/path/request/result types for every operation.
    private static void consume(Operations port, CreateBotRequest createBot, CreateBotVersionRequest version,
            CreateGroupRequest createGroup, UpdateGroupMembersRequest updateGroup) {
        BotResult created = port.createBot("space1", createBot);
        BotResult read = port.getBot("space1", created.bot.id);
        BotResult appended = port.createBotVersion("space1", read.bot.id, version);
        GroupResult group = port.createGroup("space1", createGroup);
        GroupResult updated = port.updateGroupMembers("space1", group.group.id, updateGroup);
        GroupResult snapshot = port.getGroup("space1", updated.group.id);
        Long number = appended.botVersion.number;
        GroupMember member = snapshot.group.members.get(0);
    }
}
