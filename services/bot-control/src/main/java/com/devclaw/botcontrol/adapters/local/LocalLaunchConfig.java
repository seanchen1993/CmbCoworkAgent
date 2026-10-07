package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.persistence.LocalDatabaseConfig;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;

/** Closed snapshot from the verified local launcher, never ambient config. */
public final class LocalLaunchConfig {
    public static final int MAX_BYTES = 65536;
    public final LocalDatabaseConfig database;
    public final LocalIdentityRegistry identity;
    private LocalLaunchConfig(LocalDatabaseConfig database, LocalIdentityRegistry identity) { this.database = database; this.identity = identity; }
    public static LocalLaunchConfig read(InputStream input) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int n;
            while ((n = input.read(buffer)) != -1) { if (out.size() + n > MAX_BYTES) throw invalid(); out.write(buffer, 0, n); }
            return parse(out.toByteArray());
        } catch (Exception failure) { throw invalid(); }
    }
    public static LocalLaunchConfig parse(byte[] bytes) {
        try {
            if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) throw invalid();
            String text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            ObjectMapper mapper = CompatibilityProbe.strictMapper();
            mapper.getFactory().setStreamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(16).maxStringLength(4096).maxNumberLength(128).build());
            JsonNode root = mapper.readTree(text); fields(root, "mode", "http", "db", "identity");
            if (!"local-dev".equals(string(root.get("mode")))) throw invalid();
            JsonNode http = root.get("http"); fields(http, "host", "port");
            if (!"127.0.0.1".equals(string(http.get("host"))) || !http.get("port").isIntegralNumber() || !http.get("port").canConvertToInt() || http.get("port").intValue() != 0) throw invalid();
            LocalIdentityRegistry identity = LocalIdentityRegistry.parse(root.get("identity"));
            LocalDatabaseConfig db = LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(mapper.writeValueAsBytes(root.get("db"))));
            return new LocalLaunchConfig(db, identity);
        } catch (Exception failure) { throw invalid(); }
    }
    static void fields(JsonNode node, String... allowed) {
        if (node == null || !node.isObject()) throw invalid();
        Set<String> actual = new HashSet<String>(); node.fieldNames().forEachRemaining(actual::add);
        if (!actual.equals(new HashSet<String>(Arrays.asList(allowed)))) throw invalid();
    }
    static String string(JsonNode n) { if (n == null || !n.isTextual()) throw invalid(); return n.textValue(); }
    static boolean bool(JsonNode n) { if (n == null || !n.isBoolean()) throw invalid(); return n.booleanValue(); }
    static void array(JsonNode n, int maximum) { if (n == null || !n.isArray() || n.size() > maximum) throw invalid(); }
    static IllegalArgumentException invalid() { return new IllegalArgumentException("HTTP_CONFIG"); }
    @Override public String toString() { return "LocalLaunchConfig[local-dev]"; }
}
