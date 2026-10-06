package com.devclaw.botcontrol.domain;

import com.devclaw.botcontrol.application.Operation;
import com.devclaw.botcontrol.ports.TrustedContext;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Called only after the strict original Schema boundary has consumed a typed DTO. */
public final class CanonicalCommand {
    private static final ObjectMapper JSON = new ObjectMapper().enable(JsonGenerator.Feature.ESCAPE_NON_ASCII);
    private CanonicalCommand() {}
    public static byte[] fingerprint(TrustedContext actor, Operation operation, String pathId, Object typedRequest) {
        try {
            ObjectNode request = JSON.valueToTree(typedRequest); request.remove("commandId");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (JsonGenerator out = JSON.getFactory().createGenerator(bytes)) {
                out.writeStartArray(); out.writeString(actor.spaceId); out.writeString(actor.principalId);
                out.writeString(operation.method); out.writeString(operation.path(pathId)); canonical(out, request); out.writeEndArray();
            }
            return MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());
        } catch (Exception failure) { throw new ApplicationFault(com.devclaw.botcontrol.contracts.BotContracts.ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private static void canonical(JsonGenerator out, JsonNode node) throws java.io.IOException {
        if (node.isObject()) {
            List<String> names = new ArrayList<>(); node.fieldNames().forEachRemaining(names::add); Collections.sort(names);
            out.writeStartObject(); for (String name : names) { out.writeFieldName(name); canonical(out, node.get(name)); } out.writeEndObject();
        } else if (node.isArray()) {
            out.writeStartArray(); for (JsonNode child : node) canonical(out, child); out.writeEndArray();
        } else if (node.isNumber()) { out.writeNumber(node.decimalValue().stripTrailingZeros().toPlainString()); }
        else out.writeTree(node);
    }
}
