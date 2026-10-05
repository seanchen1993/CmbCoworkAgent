package com.devclaw.botcontrol.validation;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.SchemaLocation;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class BoundaryTest {
    private static byte[] utf8(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static void rejected(Runnable call, ContractBoundary.Category category) {
        ContractBoundary.Failure failure = assertThrows(ContractBoundary.Failure.class, call::run);
        assertEquals(category, failure.category()); assertEquals(category.name(), failure.getMessage());
        assertEquals(0, failure.getStackTrace().length); assertNull(failure.getCause());
    }
    @Test void strictSyntaxAndInvalidUtf8HaveOnlySafeFailures() {
        for (String raw : new String[]{"", " ", "{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}", "{} {}", "null null", "/*sentinel*/{}", "{'a':1}", "NaN", "Infinity", "-Infinity", "01", "1.", "+1", "[1,]"})
            rejected(() -> ContractBoundary.parse(utf8(raw)), ContractBoundary.Category.JSON_SYNTAX);
        for (byte[] raw : new byte[][]{{34, (byte)0xc0, (byte)0xaf, 34}, {34, (byte)0xed, (byte)0xa0, (byte)0x80, 34}, {(byte)0xff}})
            rejected(() -> ContractBoundary.parse(raw), ContractBoundary.Category.JSON_SYNTAX);
        assertTrue(ContractBoundary.parse(utf8("{\"a\":true,\"b\":null}")).get("a").booleanValue());
    }
    @Test void parserResourcesAreBounded() {
        rejected(() -> ContractBoundary.parse(new byte[1048577]), ContractBoundary.Category.JSON_SYNTAX);
        String depth = new String(new char[65]).replace('\0', '[') + "0" + new String(new char[65]).replace('\0', ']');
        rejected(() -> ContractBoundary.parse(utf8(depth)), ContractBoundary.Category.JSON_SYNTAX);
        String number = new String(new char[129]).replace('\0', '1');
        rejected(() -> ContractBoundary.parse(utf8(number)), ContractBoundary.Category.JSON_SYNTAX);
        String text = "\"" + new String(new char[1048577]).replace('\0', 'a') + "\"";
        rejected(() -> ContractBoundary.parse(utf8(text)), ContractBoundary.Category.JSON_SYNTAX);
    }
    @Test void validSchemaPrecedesTypedConsumptionAndExactIntegersAreNotRounded() {
        ContractBoundary boundary = new ContractBoundary();
        for (String number : new String[]{"1", "1.0", "1e0", "9007199254740991"}) {
            String raw = versionRequest(number);
            CreateBotVersionRequest value = boundary.readRequest("createBotVersion", utf8(raw), CreateBotVersionRequest.class);
            assertEquals(Long.valueOf(number.startsWith("900") ? 9007199254740991L : 1L), value.expectedVersion);
            assertNull(value.config.persona); assertEquals(Capability.REPOSITORY_READ, value.config.capabilityCeiling.get(0));
        }
        for (String number : new String[]{"1.5", "9007199254740992", "1.0000000000000001", "0.99999999999999999", "9007199254740990.5", "9007199254740991.1"})
            rejected(() -> boundary.readRequest("createBotVersion", utf8(versionRequest(number)), CreateBotVersionRequest.class), ContractBoundary.Category.SCHEMA_INVALID);
        rejected(() -> boundary.readRequest("createBotVersion", utf8(versionRequest("\"1\"")), CreateBotVersionRequest.class), ContractBoundary.Category.SCHEMA_INVALID);
        rejected(() -> boundary.readRequest("createBotVersion", utf8(versionRequest("1").replace("\"description\":\"x\"", "\"description\":null")), CreateBotVersionRequest.class), ContractBoundary.Category.SCHEMA_INVALID);
        rejected(() -> boundary.readRequest("createBotVersion", utf8(versionRequest("1").replace("\"commandId\":\"c1\"", "\"commandId\":\"c1\",\"unexpected\":true")), CreateBotVersionRequest.class), ContractBoundary.Category.SCHEMA_INVALID);
        ErrorResponse response = boundary.readResponse("getBot", 503, utf8("{\"requestId\":\"r1\",\"error\":{\"code\":\"OUTCOME_UNKNOWN\",\"message\":\"safe\",\"retryable\":false}}"), ErrorResponse.class);
        assertFalse(new String(boundary.writeResponse("getBot", 503, response), StandardCharsets.UTF_8).contains("currentVersion"));
        response.error.retryable = true;
        rejected(() -> boundary.writeResponse("getBot", 503, response), ContractBoundary.Category.SCHEMA_INVALID);
    }
    private static String versionRequest(String number) {
        return "{\"commandId\":\"c1\",\"expectedVersion\":" + number + ",\"config\":{\"description\":\"x\",\"instructions\":\"x\",\"knowledgeRefs\":[],\"repositoryRefs\":[],\"skillAllowlist\":[],\"capabilityCeiling\":[\"repository.read\"],\"memoryPolicy\":\"disabled\"}}";
    }
    @Test void arbitraryRootsOperationsPathsAndRemoteLoadingAreUnavailable() {
        ContractBoundary boundary = new ContractBoundary();
        for (String root : new String[]{"Task", "Run", "../schemas.json", "https://sentinel.invalid/schema"})
            rejected(() -> boundary.validateDefinition(root, utf8("{}")), ContractBoundary.Category.SELECTION);
        rejected(() -> boundary.readRequest("../createBot", utf8("{}"), CreateBotRequest.class), ContractBoundary.Category.SELECTION);
        rejected(() -> boundary.readRequest("getBot", utf8("{}"), CreateBotRequest.class), ContractBoundary.Category.SELECTION);
        rejected(() -> boundary.readRequest("createBotVersion", utf8(versionRequest("1")), CreateBotRequest.class), ContractBoundary.Category.SELECTION);
        rejected(() -> boundary.readResponse("getBot", 299, utf8("{}"), ErrorResponse.class), ContractBoundary.Category.SELECTION);
        rejected(() -> boundary.validateParameter("getBot", "../botId", "id1"), ContractBoundary.Category.SELECTION);
        assertEquals("bot1", boundary.validateParameter("getBot", "botId", "bot1"));
        rejected(() -> boundary.validateParameter("getBot", "X-DevClaw-Space", "space1\n"), ContractBoundary.Category.SCHEMA_INVALID);
        assertThrows(RuntimeException.class, () -> boundary.offlineFactory().getSchema(SchemaLocation.of("https://sentinel.invalid/remote")));
        assertThrows(RuntimeException.class, () -> boundary.offlineFactory().getSchema(SchemaLocation.of("file:///sentinel/not-a-source")));
    }
    @Test void originalSchemaActuallyRunsEverySharedFixtureAndReportsConclusions() throws Exception {
        ContractBoundary boundary = new ContractBoundary(); ObjectMapper mapper = new ObjectMapper();
        JsonNode fixtures = mapper.readTree(BoundaryTest.class.getResourceAsStream("/parity-fixtures.json"));
        ArrayNode results = mapper.createArrayNode(); int positive = 0, negative = 0;
        for (JsonNode fixture : fixtures) {
            boolean valid = true;
            try { boundary.validateDefinition(fixture.get("schema").asText(), utf8(fixture.get("json").asText())); }
            catch (ContractBoundary.Failure failure) {
                if (failure.category() != ContractBoundary.Category.SCHEMA_INVALID) throw failure;
                valid = false;
            }
            ObjectNode result = results.addObject();
            result.put("id", fixture.get("id").asText()); result.put("schema", fixture.get("schema").asText()); result.put("valid", valid);
            if (valid) positive++; else negative++;
        }
        Files.write(Paths.get("target/parity-java-results.json"), mapper.writerWithDefaultPrettyPrinter().writeValueAsBytes(results));
        assertTrue(positive > 25); assertTrue(negative > 25);
        System.out.println("B01_A2B_PARITY " + results.size() + " actual Java conclusions, " + positive + " valid / " + negative + " invalid");
    }
}
