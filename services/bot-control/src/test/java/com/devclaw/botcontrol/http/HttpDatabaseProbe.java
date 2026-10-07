package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.sql.*;
import java.util.*;

/** Fixed disposable HTTP-fixture SQL only; never shipped in production classes. */
public final class HttpDatabaseProbe {
    private static final String[] TABLES = {"bots", "bot_versions", "bot_maintainers", "groups", "group_members", "group_bots", "command_scope", "command_receipts", "mutation_outbox"};
    private static final String[] ORDER = {"space_id,id", "space_id,id", "space_id,bot_id,principal_id", "space_id,id", "space_id,group_id,principal_id", "space_id,group_id,bot_id", "space_id,principal_id", "space_id,principal_id,command_id", "space_id,id"};
    private static final ObjectMapper JSON = CompatibilityProbe.strictMapper();
    private static String id(JsonNode n, String key) { if (!n.path(key).isTextual()) throw new IllegalStateException("TEST_FIXTURE"); return new ContractBoundary().validateParameter("getBot", "botId", n.get(key).textValue()); }
    private static void exact(JsonNode n, String... fields) { if (!n.isObject()) throw new IllegalStateException("TEST_FIXTURE"); Set<String> keys = new HashSet<String>(); n.fieldNames().forEachRemaining(keys::add); if (!keys.equals(new HashSet<String>(Arrays.asList(fields)))) throw new IllegalStateException("TEST_FIXTURE"); }
    private static ObjectNode facts(HikariDataSource source) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); ObjectNode rows = JSON.createObjectNode();
        // Hash a complete deterministic, length-delimited encoding of ALL columns
        // and rows, including null/type/name distinctions, not SELECT COUNT only.
        DataOutputStream out = new DataOutputStream(new DigestOutputStream(new OutputStream() { public void write(int value) { } }, digest));
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ); c.setAutoCommit(false);
            for (int i = 0; i < TABLES.length; i++) {
                out.writeUTF(TABLES[i]); int rowCount = 0;
                try (PreparedStatement p = c.prepareStatement("SELECT * FROM " + TABLES[i] + " ORDER BY " + ORDER[i])) {
                    p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) {
                        ResultSetMetaData m = r.getMetaData(); out.writeInt(m.getColumnCount());
                        for (int j = 1; j <= m.getColumnCount(); j++) { out.writeUTF(m.getColumnName(j)); out.writeInt(m.getColumnType(j)); }
                        while (r.next()) { rowCount++; out.writeBoolean(true); for (int j = 1; j <= m.getColumnCount(); j++) { byte[] value = r.getBytes(j); out.writeInt(value == null ? -1 : value.length); if (value != null) out.write(value); } }
                        out.writeBoolean(false);
                    }
                }
                rows.put(TABLES[i], rowCount);
            }
            c.rollback();
        }
        out.close(); StringBuilder hex = new StringBuilder(); for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b & 255));
        return JSON.createObjectNode().put("status", "verified").put("factsSha256", hex.toString()).put("tables", TABLES.length).set("rows", rows);
    }
    private static ObjectNode fixture(HikariDataSource source, String action, JsonNode n) throws Exception {
        String sql; Object[] args;
        switch (action) {
            case "expire": exact(n, "space", "principal", "command"); sql = "UPDATE command_receipts SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 8 DAY),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE space_id=? AND principal_id=? AND command_id=?"; args = new Object[]{id(n,"space"),id(n,"principal"),id(n,"command")}; break;
            case "revoke-bot": case "restore-bot": exact(n, "space", "target"); sql = "UPDATE bot_maintainers SET principal_id=? WHERE space_id=? AND bot_id=? AND principal_id=?"; args = new Object[]{action.equals("revoke-bot") ? "p9" : "p1",id(n,"space"),id(n,"target"),action.equals("revoke-bot") ? "p1" : "p9"}; break;
            case "disable-bot": case "enable-bot": exact(n, "space", "target"); sql = "UPDATE bots SET status=? WHERE space_id=? AND id=?"; args = new Object[]{action.equals("disable-bot") ? "disabled" : "active",id(n,"space"),id(n,"target")}; break;
            case "pointer": exact(n, "space", "target", "version"); sql = "UPDATE bots SET current_bot_version_id=? WHERE space_id=? AND id=?"; args = new Object[]{id(n,"version"),id(n,"space"),id(n,"target")}; break;
            case "receipt-body": exact(n, "space", "principal", "command", "body");
                if (!n.path("body").isTextual()) throw new IllegalStateException("TEST_FIXTURE"); byte[] body = Base64.getDecoder().decode(n.get("body").textValue()); if (body.length > 1048576) throw new IllegalStateException("TEST_FIXTURE");
                sql = "UPDATE command_receipts SET body_bytes=? WHERE space_id=? AND principal_id=? AND command_id=?"; args = new Object[]{body,id(n,"space"),id(n,"principal"),id(n,"command")}; break;
            case "receipt": {
                exact(n, "space", "principal", "command");
                try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement("SELECT operation,http_status,target_id,body_bytes FROM command_receipts WHERE space_id=? AND principal_id=? AND command_id=?")) {
                    p.setString(1,id(n,"space")); p.setString(2,id(n,"principal")); p.setString(3,id(n,"command")); p.setQueryTimeout(2);
                    try (ResultSet r = p.executeQuery()) { if (!r.next()) throw new IllegalStateException("TEST_FIXTURE"); ObjectNode result = JSON.createObjectNode().put("status","verified").put("operation",r.getString(1)).put("httpStatus",r.getInt(2)).put("target",r.getString(3)).put("body",Base64.getEncoder().encodeToString(r.getBytes(4))); if (r.next()) throw new IllegalStateException("TEST_FIXTURE"); return result; }
                }
            }
            default: throw new IllegalStateException("TEST_FIXTURE");
        }
        try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement(sql)) {
            c.setAutoCommit(false); for (int i = 0; i < args.length; i++) p.setObject(i + 1, args[i]); p.setQueryTimeout(2);
            if (p.executeUpdate() != 1) { c.rollback(); throw new IllegalStateException("TEST_FIXTURE"); } c.commit();
        }
        return JSON.createObjectNode().put("status", "verified").put("fixture", action);
    }
    public static void main(String[] args) {
        int exit = 1;
        try {
            if (args.length != 1 || !Arrays.asList("facts","expire","revoke-bot","restore-bot","disable-bot","enable-bot","pointer","receipt-body","receipt").contains(args[0])) throw new IllegalStateException("TEST_SELECTION");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); for (int b; (b = System.in.read()) != -1;) { if (bytes.size() == 1500000) throw new IllegalStateException("TEST_CONFIG"); bytes.write(b); }
            JsonNode root = JSON.readTree(bytes.toByteArray()); exact(root, "db", "fixture");
            LocalDatabaseConfig config = LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(root.get("db"))));
            try (HikariDataSource source = config.openPool()) { DatabaseReadiness.requireReady(source); System.out.println(args[0].equals("facts") ? facts(source) : fixture(source,args[0],root.get("fixture"))); exit = 0; }
        } catch (Exception failure) { System.out.println("{\"status\":\"failed\",\"category\":\"C2_SQL_FIXTURE\"}"); }
        System.exit(exit);
    }
}
