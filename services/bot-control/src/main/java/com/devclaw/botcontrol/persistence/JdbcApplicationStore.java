package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.TransactionObserver;
import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.time.format.DateTimeFormatter;
import java.util.*;

/** Fixed, parameterized SQL, scoped to a single trusted space and transaction.
 * The caller owns transaction/parent lock ordering; no SQL/table selector API. */
public final class JdbcApplicationStore {
    private static final ObjectMapper JSON = new ObjectMapper().enable(JsonGenerator.Feature.ESCAPE_NON_ASCII);
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    private final Connection connection;
    private final String space;
    private final TransactionObserver observer;
    public JdbcApplicationStore(Connection connection, String space, TransactionObserver observer) { this.connection = connection; this.space = space; this.observer = observer; }
    private static Calendar utc() { return Calendar.getInstance(TimeZone.getTimeZone("UTC")); }
    public static String text(Timestamp time) { return DateTimeFormatter.ISO_INSTANT.format(time.toInstant()); }
    public static byte[] json(Object value) {
        try { return StorageCodec.boundedBody(JSON.writeValueAsBytes(value)); }
        catch (Exception failure) { throw corrupt(); }
    }
    private static byte[] envelope(String prefix, byte[] stored, String suffix) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); bytes.write(prefix.getBytes(StandardCharsets.US_ASCII));
            bytes.write(StorageCodec.boundedBody(stored)); bytes.write(suffix.getBytes(StandardCharsets.US_ASCII)); return StorageCodec.boundedBody(bytes.toByteArray());
        } catch (Exception failure) { throw corrupt(); }
    }
    public static BotConfig storedConfig(byte[] stored) {
        try {
            // Validate ORIGINAL persisted bytes before conversion; fixed schema envelope,
            // not a mapper tree/DTO that could discard duplicate keys or coerce types.
            return BOUNDARY.readRequest("createBot", envelope("{\"commandId\":\"storage\",\"name\":\"storage\",\"config\":", stored, ",\"maintainerIds\":[\"storage\"]}"), CreateBotRequest.class).config;
        } catch (RuntimeException failure) { throw corrupt(); }
    }
    public static GroupLimits storedLimits(byte[] stored) {
        try {
            return BOUNDARY.readRequest("createGroup", envelope("{\"commandId\":\"storage\",\"name\":\"storage\",\"limits\":", stored,
                ",\"members\":[{\"principalId\":\"storage\",\"role\":\"admin\"}],\"bots\":[{\"botId\":\"storage\",\"botVersionId\":\"storage\",\"role\":\"specialist\"}]}"), CreateGroupRequest.class).limits;
        } catch (RuntimeException failure) { throw corrupt(); }
    }
    public static ApplicationFault corrupt() { return new ApplicationFault(ErrorCode.DEPENDENCY_UNAVAILABLE); }
    private PreparedStatement prepare(String sql, Object... values) throws SQLException {
        PreparedStatement p = connection.prepareStatement(sql);
        try {
            p.setQueryTimeout(2);
            for (int i = 0; i < values.length; i++) {
                Object value = values[i];
                if (value instanceof byte[]) p.setBytes(i + 1, (byte[])value);
                else if (value instanceof Timestamp) p.setTimestamp(i + 1, (Timestamp)value, utc());
                else p.setObject(i + 1, value);
            }
            return p;
        } catch (SQLException failure) { p.close(); throw failure; }
    }
    private void change(String sql, int expected, Object... values) throws SQLException {
        try (PreparedStatement p = prepare(sql, values)) { if (p.executeUpdate() != expected) throw corrupt(); }
    }
    public Timestamp now() throws SQLException {
        try (PreparedStatement p = prepare("SELECT UTC_TIMESTAMP(3)"); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw corrupt(); Timestamp time = r.getTimestamp(1, utc()); if (time == null || r.next()) throw corrupt(); return time;
        }
    }
    public void lockScope(String principal) throws SQLException {
        // The unique scope row serializes commands across independent JVMs.
        try (PreparedStatement p = prepare("INSERT INTO command_scope(space_id,principal_id) VALUES(?,?) ON DUPLICATE KEY UPDATE principal_id=VALUES(principal_id)", space, principal)) { p.executeUpdate(); }
        try (PreparedStatement p = prepare("SELECT principal_id FROM command_scope WHERE space_id=? AND principal_id=? FOR UPDATE", space, principal); ResultSet r = p.executeQuery()) {
            if (!r.next() || !principal.equals(r.getString(1)) || r.next()) throw corrupt();
        }
    }
    public static final class Receipt {
        public final String operation, type, target;
        public final int status;
        public final byte[] fingerprint, body;
        public final Timestamp created, expires;
        private Receipt(ResultSet r) throws SQLException {
            operation = r.getString(1); type = r.getString(2); target = r.getString(3); fingerprint = r.getBytes(4);
            status = r.getInt(5); body = StorageCodec.boundedBody(r.getBytes(6)); created = r.getTimestamp(7, utc()); expires = r.getTimestamp(8, utc());
            if (fingerprint == null || fingerprint.length != 32 || created == null || expires == null || expires.getTime() - created.getTime() != 604800000L) throw corrupt();
        }
    }
    public Receipt receipt(String principal, String command) throws SQLException {
        try (PreparedStatement p = prepare("SELECT operation,target_type,target_id,fingerprint,http_status,body_bytes,created_at,expires_at FROM command_receipts WHERE space_id=? AND principal_id=? AND command_id=? FOR UPDATE", space, principal, command); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; Receipt result = new Receipt(r); if (r.next()) throw corrupt(); return result;
        }
    }
    public Bot bot(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT id,version,name_json,status,current_bot_version_id,created_at,updated_at FROM bots WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null;
            Bot b = new Bot(); b.id = r.getString(1); b.spaceId = space; b.version = r.getLong(2); b.name = StorageCodec.decodeName(r.getString(3));
            try { b.status = BotStatus.fromWire(r.getString(4)); } catch (Exception failure) { throw corrupt(); }
            b.currentBotVersionId = r.getString(5); b.createdAt = text(r.getTimestamp(6, utc())); b.updatedAt = text(r.getTimestamp(7, utc()));
            if (r.next()) throw corrupt(); b.maintainerIds = maintainers(id); return b;
        }
    }
    private List<String> maintainers(String bot) throws SQLException {
        List<String> result = new ArrayList<>();
        try (PreparedStatement p = prepare("SELECT principal_id,ordinal FROM bot_maintainers WHERE space_id=? AND bot_id=? ORDER BY ordinal FOR UPDATE", space, bot); ResultSet r = p.executeQuery()) {
            while (r.next()) { if (r.getInt(2) != result.size()) throw corrupt(); result.add(r.getString(1)); }
        }
        if (result.isEmpty()) throw corrupt(); return result;
    }
    public BotVersion version(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT id,bot_id,number,config_bytes,created_at FROM bot_versions WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; BotVersion v = new BotVersion(); v.id = r.getString(1); v.botId = r.getString(2); v.spaceId = space;
            v.number = r.getLong(3); v.config = storedConfig(r.getBytes(4)); v.createdAt = text(r.getTimestamp(5, utc())); if (r.next()) throw corrupt(); return v;
        }
    }
    public long latestVersionNumber(String bot) throws SQLException {
        try (PreparedStatement p = prepare("SELECT MIN(number),MAX(number) FROM bot_versions WHERE space_id=? AND bot_id=?", space, bot); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw corrupt(); long min = r.getLong(1), max = r.getLong(2); if (r.wasNull() || min < 1 || max > 9007199254740991L || r.next()) throw corrupt(); return max;
        }
    }
    /** Metadata-only lookup to locate a receipt target; does not authorize or expose content. */
    public String versionOwner(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT bot_id FROM bot_versions WHERE space_id=? AND id=?", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw corrupt(); String owner = r.getString(1); if (r.next()) throw corrupt(); return owner;
        }
    }
    public Group group(String id) throws SQLException {
        Group g;
        try (PreparedStatement p = prepare("SELECT id,version,name_json,limits_bytes,created_at,updated_at FROM groups WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; g = new Group(); g.id = r.getString(1); g.spaceId = space; g.version = r.getLong(2);
            g.name = StorageCodec.decodeName(r.getString(3)); g.limits = storedLimits(r.getBytes(4));
            g.createdAt = text(r.getTimestamp(5, utc())); g.updatedAt = text(r.getTimestamp(6, utc())); if (r.next()) throw corrupt();
        }
        g.members = new ArrayList<>(); g.bots = new ArrayList<>();
        try (PreparedStatement p = prepare("SELECT principal_id,role,ordinal FROM group_members WHERE space_id=? AND group_id=? ORDER BY ordinal FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            while (r.next()) {
                if (r.getInt(3) != g.members.size()) throw corrupt(); GroupMember m = new GroupMember(); m.principalId = r.getString(1);
                try { m.role = GroupMemberRole.fromWire(r.getString(2)); } catch (Exception failure) { throw corrupt(); } g.members.add(m);
            }
        }
        try (PreparedStatement p = prepare("SELECT bot_id,bot_version_id,role,ordinal FROM group_bots WHERE space_id=? AND group_id=? ORDER BY ordinal FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            while (r.next()) {
                if (r.getInt(4) != g.bots.size()) throw corrupt(); GroupBot b = new GroupBot(); b.botId = r.getString(1); b.botVersionId = r.getString(2);
                try { b.role = GroupBotRole.fromWire(r.getString(3)); } catch (Exception failure) { throw corrupt(); } g.bots.add(b);
            }
        }
        if (g.members.isEmpty() || g.bots.isEmpty()) throw corrupt(); return g;
    }
    public void createBot(Bot b, BotVersion v) throws SQLException {
        change("INSERT INTO bots(space_id,id,version,name_json,status,current_bot_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", 1,
            space, b.id, b.version, StorageCodec.encodeName(b.name), b.status.wire(), b.currentBotVersionId, Timestamp.from(java.time.Instant.parse(b.createdAt)), Timestamp.from(java.time.Instant.parse(b.updatedAt)));
        appendVersion(v);
        for (int i = 0; i < b.maintainerIds.size(); i++) change("INSERT INTO bot_maintainers(space_id,bot_id,principal_id,ordinal) VALUES(?,?,?,?)", 1, space, b.id, b.maintainerIds.get(i), i);
    }
    public void appendVersion(BotVersion v) throws SQLException {
        change("INSERT INTO bot_versions(space_id,id,bot_id,number,config_bytes,created_at) VALUES(?,?,?,?,?,?)", 1, space, v.id, v.botId, v.number, json(v.config), Timestamp.from(java.time.Instant.parse(v.createdAt)));
        observer.reached(TransactionObserver.Stage.VERSION_WRITTEN);
    }
    public void advanceBot(Bot b, long expected) throws SQLException {
        change("UPDATE bots SET version=?,current_bot_version_id=?,updated_at=? WHERE space_id=? AND id=? AND version=?", 1,
            b.version, b.currentBotVersionId, Timestamp.from(java.time.Instant.parse(b.updatedAt)), space, b.id, expected);
    }
    public void createGroup(Group g) throws SQLException {
        change("INSERT INTO groups(space_id,id,version,name_json,limits_bytes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", 1,
            space, g.id, g.version, StorageCodec.encodeName(g.name), json(g.limits), Timestamp.from(java.time.Instant.parse(g.createdAt)), Timestamp.from(java.time.Instant.parse(g.updatedAt)));
        insertCollections(g);
    }
    public void replaceGroup(Group g, long expected, int oldMembers, int oldBots) throws SQLException {
        change("UPDATE groups SET version=?,updated_at=? WHERE space_id=? AND id=? AND version=?", 1, g.version, Timestamp.from(java.time.Instant.parse(g.updatedAt)), space, g.id, expected);
        change("DELETE FROM group_members WHERE space_id=? AND group_id=?", oldMembers, space, g.id);
        change("DELETE FROM group_bots WHERE space_id=? AND group_id=?", oldBots, space, g.id);
        insertCollections(g);
    }
    private void insertCollections(Group g) throws SQLException {
        for (int i = 0; i < g.members.size(); i++) {
            GroupMember m = g.members.get(i); change("INSERT INTO group_members(space_id,group_id,principal_id,role,ordinal) VALUES(?,?,?,?,?)", 1, space, g.id, m.principalId, m.role.wire(), i);
            observer.reached(TransactionObserver.Stage.MEMBER_WRITTEN);
        }
        for (int i = 0; i < g.bots.size(); i++) {
            GroupBot b = g.bots.get(i); change("INSERT INTO group_bots(space_id,group_id,bot_id,bot_version_id,role,ordinal) VALUES(?,?,?,?,?,?)", 1, space, g.id, b.botId, b.botVersionId, b.role.wire(), i);
        }
    }
    public void record(String principal, String command, String operation, String receiptType, String receiptTarget, byte[] fingerprint,
                       int status, byte[] body, String targetType, String target, long version, Timestamp now) throws SQLException {
        change("INSERT INTO command_receipts(space_id,principal_id,command_id,operation,target_type,target_id,fingerprint,http_status,body_bytes,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", 1,
            space, principal, command, operation, receiptType, receiptTarget, fingerprint, status, StorageCodec.boundedBody(body), now, new Timestamp(now.getTime() + 604800000L));
        change("INSERT INTO mutation_outbox(space_id,id,principal_id,command_id,operation,target_type,target_id,target_version,created_at) VALUES(?,?,?,?,?,?,?,?,?)", 1,
            space, UUID.randomUUID().toString(), principal, command, operation, targetType, target, version, now);
    }
}
