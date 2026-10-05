package com.devclaw.botcontrol.validation;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SchemaLocation;
import com.networknt.schema.SchemaValidatorsConfig;
import com.networknt.schema.SpecVersion.VersionFlag;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/** Offline structural boundary only. No transport, identity, persistence or business semantics. */
public final class ContractBoundary {
    public enum Category { JSON_SYNTAX, SCHEMA_INVALID, SCHEMA_RESOURCE, SELECTION, DTO_INVALID }
    public static final class Failure extends RuntimeException {
        private final Category category;
        Failure(Category category) { super(category.name(), null, false, false); this.category = category; }
        public Category category() { return category; }
    }
    private static final String PREFIX = "/contracts/bot/v1/";
    private static final int MAX_BYTES = 1048576;
    private final ObjectMapper mapper = CompatibilityProbe.strictMapper();
    private final JsonNode manifest;
    private final Map<String, JsonSchema> schemas = new HashMap<String, JsonSchema>();
    private final JsonSchemaFactory factory;

    public ContractBoundary() {
        try {
            manifest = mapper.readTree(resource("manifest.json"));
            final Map<String, byte[]> sources = new HashMap<String, byte[]>();
            for (String file : new String[]{"schemas.json", "openapi.json", "state-transitions.json"}) {
                byte[] bytes = resource(file);
                if (!digest(bytes).equals(manifest.path("hashes").path(file).asText())) throw new Failure(Category.SCHEMA_RESOURCE);
                JsonNode document = mapper.readTree(bytes);
                if (!file.equals("openapi.json")) sources.put(document.path("$id").asText(), bytes);
            }
            factory = JsonSchemaFactory.getInstance(VersionFlag.V202012, builder -> builder.schemaLoaders(loaders -> loaders.values(values -> {
                values.clear();
                values.add(iri -> {
                    byte[] bytes = sources.get(iri.toString());
                    if (bytes == null) throw new Failure(Category.SCHEMA_RESOURCE);
                    return () -> new ByteArrayInputStream(bytes);
                });
            })));
            SchemaValidatorsConfig config = SchemaValidatorsConfig.builder().formatAssertionsEnabled(true).typeLoose(false).build();
            for (JsonNode name : manifest.path("definitions")) {
                String definition = name.asText();
                if (!definition.matches("[A-Za-z][A-Za-z0-9]*")) throw new Failure(Category.SCHEMA_RESOURCE);
                schemas.put(definition, factory.getSchema(SchemaLocation.of("https://contracts.devclaw.invalid/bot/v1/schemas.json#/$defs/" + definition), config));
            }
            if (schemas.isEmpty()) throw new Failure(Category.SCHEMA_RESOURCE);
        } catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(Category.SCHEMA_RESOURCE); }
    }

    private static byte[] resource(String file) throws Exception {
        try (InputStream input = ContractBoundary.class.getResourceAsStream(PREFIX + file)) {
            if (input == null) throw new Failure(Category.SCHEMA_RESOURCE);
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) { output.write(buffer, 0, count); if (output.size() > MAX_BYTES) throw new Failure(Category.SCHEMA_RESOURCE); }
            return output.toByteArray();
        }
    }
    private static String digest(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
    static JsonNode parse(byte[] bytes) {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) throw new Failure(Category.JSON_SYNTAX);
        try {
            JsonNode result = CompatibilityProbe.strictRead(bytes);
            if (result == null || result.isMissingNode()) throw new Failure(Category.JSON_SYNTAX);
            return result;
        } catch (Exception failure) { throw new Failure(Category.JSON_SYNTAX); }
    }
    JsonNode validateDefinition(String definition, byte[] bytes) {
        JsonSchema schema = schemas.get(definition);
        if (schema == null) throw new Failure(Category.SELECTION);
        JsonNode value = parse(bytes);
        try { if (!schema.validate(value).isEmpty()) throw new Failure(Category.SCHEMA_INVALID); }
        catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(Category.SCHEMA_RESOURCE); }
        return value;
    }
    JsonSchemaFactory offlineFactory() { return factory; } // package-private policy test seam, not an input-loading API.
    private JsonNode operation(String operation) {
        JsonNode value = operation == null ? null : manifest.path("operations").get(operation);
        if (value == null) throw new Failure(Category.SELECTION);
        return value;
    }
    private <T> T consume(String definition, byte[] bytes, Class<T> type) {
        try {
            Class<?> expected = Class.forName(BotContracts.class.getName() + "$" + definition);
            if (!expected.equals(type)) throw new Failure(Category.SELECTION);
            return mapper.treeToValue(integralNodes(validateDefinition(definition, bytes)), type);
        } catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(Category.DTO_INVALID); }
    }
    // After validation only: canonical mathematical integers bind to Long without Double or truncation.
    private JsonNode integralNodes(JsonNode node) {
        if (node.isFloatingPointNumber()) {
            BigDecimal decimal = node.decimalValue().stripTrailingZeros();
            if (decimal.scale() <= 0) return mapper.getNodeFactory().numberNode(decimal.toBigIntegerExact());
        } else if (node.isObject()) {
            ObjectNode result = mapper.createObjectNode();
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) { Map.Entry<String, JsonNode> field = fields.next(); result.set(field.getKey(), integralNodes(field.getValue())); }
            return result;
        } else if (node.isArray()) {
            ArrayNode result = mapper.createArrayNode(); for (JsonNode child : node) result.add(integralNodes(child)); return result;
        }
        return node;
    }
    public <T> T readRequest(String operation, byte[] bytes, Class<T> type) {
        String definition = operation(operation).path("request").asText();
        if (definition.isEmpty()) throw new Failure(Category.SELECTION);
        return consume(definition, bytes, type);
    }
    public <T> T readResponse(String operation, int status, byte[] bytes, Class<T> type) {
        String definition = operation(operation).path("responses").path(String.valueOf(status)).asText();
        if (definition.isEmpty()) throw new Failure(Category.SELECTION);
        return consume(definition, bytes, type);
    }
    public <T> byte[] writeResponse(String operation, int status, T value) {
        if (value == null) throw new Failure(Category.DTO_INVALID);
        try {
            byte[] bytes = mapper.writeValueAsBytes(value);
            readResponse(operation, status, bytes, value.getClass());
            return bytes;
        } catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(Category.DTO_INVALID); }
    }
    public String validateParameter(String operation, String name, String value) {
        String definition = operation(operation).path("parameters").path(name == null ? "" : name).asText();
        if (definition.isEmpty()) throw new Failure(Category.SELECTION);
        try { validateDefinition(definition, mapper.writeValueAsBytes(value)); return value; }
        catch (Failure failure) { throw failure; }
        catch (Exception failure) { throw new Failure(Category.DTO_INVALID); }
    }
}
