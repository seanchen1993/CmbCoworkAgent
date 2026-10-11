package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.Capability;
import com.fasterxml.jackson.databind.JsonNode;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** Fixed space-scoped SQL. Caller locks Group -> Task/Bot -> grant -> node.
 * Heartbeats lock only their node. No secret, path, Run or lease is stored here. */
public final class JdbcRuntimeNodeStore {
    private final Connection c; private final String space;
    public JdbcRuntimeNodeStore(Connection c, String space) { this.c = c; this.space = space; }
    private static Calendar utc() { return Calendar.getInstance(TimeZone.getTimeZone("UTC")); }
    private PreparedStatement prepare(String sql, Object... values) throws SQLException {
        PreparedStatement p = c.prepareStatement(sql);
        try {
            p.setQueryTimeout(2);
            for (int i = 0; i < values.length; i++) {
                Object v = values[i];
                if (v instanceof byte[]) p.setBytes(i + 1, (byte[])v);
                else if (v instanceof Instant) p.setTimestamp(i + 1, Timestamp.from((Instant)v), utc());
                else p.setObject(i + 1, v);
            }
            return p;
        } catch (SQLException failure) { p.close(); throw failure; }
    }
    private void change(String sql, Object... values) throws SQLException {
        try (PreparedStatement p = prepare(sql, values)) { if (p.executeUpdate() != 1) throw JdbcApplicationStore.corrupt(); }
    }
    private static String id(String value) {
        if (value == null || value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) throw JdbcApplicationStore.corrupt(); return value;
    }
    private static long version(long value) { if (value < 1 || value > JdbcTaskStore.MAX) throw JdbcApplicationStore.corrupt(); return value; }
    private static boolean flag(int value) { if (value != 0 && value != 1) throw JdbcApplicationStore.corrupt(); return value == 1; }
    private static Instant instant(ResultSet r, int index) throws SQLException {
        Timestamp t = r.getTimestamp(index, utc()); if (t == null || t.getNanos() % 1000000 != 0) throw JdbcApplicationStore.corrupt(); return t.toInstant();
    }
    public static Set<Capability> storedCapabilities(byte[] bytes) {
        try {
            if (bytes == null || bytes.length > 512) throw JdbcApplicationStore.corrupt();
            JsonNode n = CompatibilityProbe.strictMapper().readTree(bytes);
            if (!n.isArray() || n.size() > Capability.values().length) throw JdbcApplicationStore.corrupt();
            EnumSet<Capability> values = EnumSet.noneOf(Capability.class);
            for (JsonNode element : n) if (!element.isTextual() || !values.add(Capability.fromWire(element.textValue()))) throw JdbcApplicationStore.corrupt();
            return Collections.unmodifiableSet(values);
        } catch (Exception failure) { throw JdbcApplicationStore.corrupt(); }
    }
    public static final class Node {
        public final String id, ownerPrincipalId;
        public final long version;
        public final boolean supportsRequirement;
        public final Set<Capability> capabilities;
        public final Instant lastSeenAt, createdAt, updatedAt;
        private Node(String id, ResultSet r) throws SQLException {
            this.id = id(id); ownerPrincipalId = id(r.getString(1)); version = version(r.getLong(2)); supportsRequirement = flag(r.getInt(3));
            capabilities = storedCapabilities(r.getBytes(4)); lastSeenAt = instant(r, 5); createdAt = instant(r, 6); updatedAt = instant(r, 7);
            if (lastSeenAt.isBefore(createdAt) || updatedAt.isBefore(createdAt)) throw JdbcApplicationStore.corrupt();
        }
    }
    public static final class Grant {
        public final String id, groupId, nodeId, ownerPrincipalId, workspaceRef;
        public final long version;
        public final boolean enabled;
        public final Instant expiresAt, createdAt, updatedAt;
        private Grant(String groupId, ResultSet r) throws SQLException {
            this.groupId = id(groupId); id = id(r.getString(1)); nodeId = id(r.getString(2)); ownerPrincipalId = id(r.getString(3));
            version = version(r.getLong(4)); workspaceRef = id(r.getString(5)); enabled = flag(r.getInt(6));
            expiresAt = instant(r, 7); createdAt = instant(r, 8); updatedAt = instant(r, 9);
            if (updatedAt.isBefore(createdAt)) throw JdbcApplicationStore.corrupt();
        }
    }
    public Node node(String id) throws SQLException {
        try (PreparedStatement p = prepare("SELECT owner_principal_id,version,supports_requirement,capabilities_bytes,last_seen_at,created_at,updated_at FROM desktop_runtime_nodes WHERE space_id=? AND id=? FOR UPDATE", space, id); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; Node value = new Node(id, r); if (r.next()) throw JdbcApplicationStore.corrupt(); return value;
        }
    }
    public Grant grant(String group) throws SQLException {
        try (PreparedStatement p = prepare("SELECT id,node_id,owner_principal_id,version,workspace_ref,enabled,expires_at,created_at,updated_at FROM group_runtime_grants WHERE space_id=? AND group_id=? FOR UPDATE", space, group); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; Grant value = new Grant(group, r); if (r.next()) throw JdbcApplicationStore.corrupt(); return value;
        }
    }
    public void ensureNode(String id, String owner, boolean supports, Set<Capability> capabilities) throws SQLException {
        // Unique key serializes first registration. Duplicate never changes owner.
        try (PreparedStatement p = prepare("INSERT INTO desktop_runtime_nodes(space_id,id,owner_principal_id,version,supports_requirement,capabilities_bytes,last_seen_at,created_at,updated_at) VALUES(?,?,?,1,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=VALUES(id)", space, id, owner, supports ? 1 : 0, JdbcApplicationStore.json(capabilities))) { p.executeUpdate(); }
    }
    public Node observe(Node old, boolean supports, Set<Capability> capabilities, Instant now) throws SQLException {
        boolean changed = old.supportsRequirement != supports || !old.capabilities.equals(capabilities);
        if (changed && old.version == JdbcTaskStore.MAX) throw JdbcApplicationStore.corrupt();
        // No version increment for a heartbeat; capability changes invalidate snapshots.
        change("UPDATE desktop_runtime_nodes SET version=?,supports_requirement=?,capabilities_bytes=?,last_seen_at=?,updated_at=? WHERE space_id=? AND id=? AND version=?", old.version + (changed ? 1 : 0), supports ? 1 : 0, JdbcApplicationStore.json(capabilities), now, changed ? now : old.updatedAt, space, old.id, old.version);
        return node(old.id);
    }
    public Grant authorize(Grant old, String group, String node, String owner, String workspace, Instant expires, Instant now) throws SQLException {
        if (old == null) change("INSERT INTO group_runtime_grants(space_id,group_id,id,node_id,owner_principal_id,version,workspace_ref,enabled,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,1,?,1,?,?,?)", space, group, UUID.randomUUID().toString(), node, owner, workspace, expires, now, now);
        else {
            if (old.version == JdbcTaskStore.MAX) throw JdbcApplicationStore.corrupt();
            change("UPDATE group_runtime_grants SET node_id=?,owner_principal_id=?,version=?,workspace_ref=?,enabled=1,expires_at=?,updated_at=? WHERE space_id=? AND group_id=? AND version=?", node, owner, old.version + 1, workspace, expires, now, space, group, old.version);
        }
        return grant(group);
    }
    public Grant revoke(Grant old, Instant now) throws SQLException {
        if (old.version == JdbcTaskStore.MAX) throw JdbcApplicationStore.corrupt();
        change("UPDATE group_runtime_grants SET enabled=0,version=?,updated_at=? WHERE space_id=? AND group_id=? AND version=?", old.version + 1, now, space, old.groupId, old.version);
        return grant(old.groupId);
    }
}
