package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.application.RuntimeNodeApplication.RequirementDispatch;
import java.security.MessageDigest;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** One-attempt internal queue. Group lock serializes enqueue/claim/cancel.
 * Not a public Run DTO or an executable RunSpec. No secret or absolute path. */
public final class JdbcRequirementRunStore {
    public enum Status { QUEUED, WAITING_NODE, STARTING, CANCEL_REQUESTED, CANCELLED, OUTCOME_UNKNOWN }
    private final Connection c; private final String space;
    public JdbcRequirementRunStore(Connection c, String space) { this.c = c; this.space = space; }
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
    private static Instant instant(ResultSet r, String key) throws SQLException {
        Timestamp t = r.getTimestamp(key, utc());
        if (t == null || t.getNanos() % 1000000 != 0) throw JdbcApplicationStore.corrupt(); return t.toInstant();
    }
    private static Status status(String text) {
        try { Status value = Status.valueOf(text.toUpperCase(Locale.ROOT)); if (!wire(value).equals(text)) throw JdbcApplicationStore.corrupt(); return value; } catch (Exception failure) { throw JdbcApplicationStore.corrupt(); }
    }
    private static String wire(Status status) { return status.name().toLowerCase(Locale.ROOT); }
    public static final class Run {
        public final String spaceId, id, requesterPrincipalId, commandId, groupId, taskId, stageId, botId, botVersionId, nodeId, ownerPrincipalId, grantId, workspaceRef;
        public final long version, taskVersion, groupVersion, nodeVersion, grantVersion;
        public final Status status, initialStatus;
        public final Instant deadline, createdAt, updatedAt, leaseExpiresAt;
        public final String attemptId, leaseId;
        public final Long fence;
        public final boolean readOnly = true;
        private final byte[] fingerprint;
        private Run(String space, ResultSet r) throws SQLException {
            spaceId = id(space); id = id(r.getString("id")); requesterPrincipalId = id(r.getString("requester_principal_id")); commandId = id(r.getString("command_id"));
            groupId = id(r.getString("group_id")); taskId = id(r.getString("task_id")); stageId = id(r.getString("stage_id")); botId = id(r.getString("bot_id")); botVersionId = id(r.getString("bot_version_id"));
            nodeId = id(r.getString("node_id")); ownerPrincipalId = id(r.getString("owner_principal_id")); grantId = id(r.getString("grant_id")); workspaceRef = id(r.getString("workspace_ref"));
            version = version(r.getLong("version")); taskVersion = version(r.getLong("task_version")); groupVersion = version(r.getLong("group_version")); nodeVersion = version(r.getLong("node_version")); grantVersion = version(r.getLong("grant_version"));
            status = status(r.getString("status")); initialStatus = status(r.getString("initial_status"));
            if (initialStatus != Status.QUEUED && initialStatus != Status.WAITING_NODE) throw JdbcApplicationStore.corrupt();
            deadline = instant(r, "deadline"); createdAt = instant(r, "created_at"); updatedAt = instant(r, "updated_at");
            if (!deadline.isAfter(createdAt) || updatedAt.isBefore(createdAt)) throw JdbcApplicationStore.corrupt();
            fingerprint = r.getBytes("fingerprint"); if (fingerprint == null || fingerprint.length != 32) throw JdbcApplicationStore.corrupt();
            attemptId = r.getString("attempt_id"); leaseId = r.getString("lease_id"); long f = r.getLong("fence"); fence = r.wasNull() ? null : Long.valueOf(f);
            Timestamp expiry = r.getTimestamp("lease_expires_at", utc()); leaseExpiresAt = expiry == null ? null : expiry.toInstant();
            boolean claimed = status == Status.STARTING || status == Status.OUTCOME_UNKNOWN;
            if (claimed) {
                id(attemptId); id(leaseId);
                if (fence == null || fence != 1 || leaseExpiresAt == null || leaseExpiresAt.getNano() % 1000000 != 0 || !leaseExpiresAt.isAfter(createdAt) || leaseExpiresAt.isAfter(deadline) || version < 2) throw JdbcApplicationStore.corrupt();
            } else if (attemptId != null || leaseId != null || fence != null || leaseExpiresAt != null) throw JdbcApplicationStore.corrupt();
            if (status == Status.QUEUED && version != 1 || status == Status.OUTCOME_UNKNOWN && version < 3 || status == Status.CANCELLED && version < 3 || status == Status.CANCEL_REQUESTED) throw JdbcApplicationStore.corrupt();
        }
        public boolean sameCommand(byte[] hash) { return MessageDigest.isEqual(fingerprint, hash); }
        public boolean sameSnapshot(RequirementDispatch d) {
            return spaceId.equals(d.spaceId) && requesterPrincipalId.equals(d.requesterPrincipalId) && groupId.equals(d.groupId) && taskId.equals(d.taskId) && stageId.equals(d.stageId) &&
                botId.equals(d.botId) && botVersionId.equals(d.botVersionId) && nodeId.equals(d.nodeId) && ownerPrincipalId.equals(d.ownerPrincipalId) && grantId.equals(d.grantId) && workspaceRef.equals(d.workspaceRef) &&
                taskVersion == d.taskVersion && groupVersion == d.groupVersion && nodeVersion == d.nodeVersion && grantVersion == d.grantVersion;
        }
    }
    public String groupId(String runId) throws SQLException {
        try (PreparedStatement p = prepare("SELECT group_id FROM requirement_run_queue WHERE space_id=? AND id=?", space, runId); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; String g = id(r.getString(1)); if (r.next()) throw JdbcApplicationStore.corrupt(); return g;
        }
    }
    private Run one(String sql, Object... values) throws SQLException {
        try (PreparedStatement p = prepare(sql, values); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; Run run = new Run(space, r); if (r.next()) throw JdbcApplicationStore.corrupt(); return run;
        }
    }
    public Run run(String id) throws SQLException { return one("SELECT * FROM requirement_run_queue WHERE space_id=? AND id=? FOR UPDATE", space, id); }
    public Run command(String requester, String command) throws SQLException { return one("SELECT * FROM requirement_run_queue WHERE space_id=? AND requester_principal_id=? AND command_id=? FOR UPDATE", space, requester, command); }
    public String commandGroupId(String requester, String command) throws SQLException {
        try (PreparedStatement p = prepare("SELECT group_id FROM requirement_run_queue WHERE space_id=? AND requester_principal_id=? AND command_id=?", space, requester, command); ResultSet r = p.executeQuery()) {
            if (!r.next()) return null; String group = id(r.getString(1)); if (r.next()) throw JdbcApplicationStore.corrupt(); return group;
        }
    }
    public long activeCount(String group) throws SQLException {
        // Unknown execution remains reserved until a future explicit reconciliation.
        try (PreparedStatement p = prepare("SELECT COUNT(*) FROM requirement_run_queue WHERE space_id=? AND group_id=? AND status<>'cancelled'", space, group); ResultSet r = p.executeQuery()) {
            if (!r.next()) throw JdbcApplicationStore.corrupt(); return r.getLong(1);
        }
    }
    public Run enqueue(String command, byte[] hash, RequirementDispatch d, Instant deadline, Status status) throws SQLException {
        String runId = UUID.randomUUID().toString();
        change("INSERT INTO requirement_run_queue(space_id,id,requester_principal_id,command_id,fingerprint,group_id,task_id,stage_id,bot_id,bot_version_id,node_id,owner_principal_id,grant_id,workspace_ref,task_version,group_version,node_version,grant_version,version,initial_status,status,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)",
            space, runId, d.requesterPrincipalId, command, hash, d.groupId, d.taskId, d.stageId, d.botId, d.botVersionId, d.nodeId, d.ownerPrincipalId, d.grantId, d.workspaceRef, d.taskVersion, d.groupVersion, d.nodeVersion, d.grantVersion, wire(status), wire(status), deadline, d.observedAt, d.observedAt);
        return run(runId);
    }
    public Run claim(Run old, Instant now, Instant expiry) throws SQLException {
        change("UPDATE requirement_run_queue SET status='starting',version=?,updated_at=?,attempt_id=?,lease_id=?,fence=1,lease_expires_at=? WHERE space_id=? AND id=? AND version=? AND status IN ('queued','waiting_node')",
            next(old, 1), now, UUID.randomUUID().toString(), UUID.randomUUID().toString(), expiry, space, old.id, old.version); return run(old.id);
    }
    private static long next(Run old, int delta) { if (old.version > JdbcTaskStore.MAX - delta) throw JdbcApplicationStore.corrupt(); return old.version + delta; }
    public Run waitForNode(Run old, Instant now) throws SQLException {
        change("UPDATE requirement_run_queue SET status='waiting_node',version=?,updated_at=? WHERE space_id=? AND id=? AND version=? AND status='queued'", next(old, 1), now, space, old.id, old.version); return run(old.id);
    }
    public Run expiredClaim(Run old, Instant now) throws SQLException {
        change("UPDATE requirement_run_queue SET status='outcome_unknown',version=?,updated_at=? WHERE space_id=? AND id=? AND version=? AND status='starting'", next(old, 1), now, space, old.id, old.version); return run(old.id);
    }
    public Run cancelPending(Run old, Instant now) throws SQLException {
        // Neither status is externally observed before commit; no attempt exists.
        change("UPDATE requirement_run_queue SET status='cancel_requested',version=?,updated_at=? WHERE space_id=? AND id=? AND version=? AND status IN ('queued','waiting_node')", next(old, 1), now, space, old.id, old.version);
        change("UPDATE requirement_run_queue SET status='cancelled',version=? WHERE space_id=? AND id=? AND version=? AND status='cancel_requested'", next(old, 2), space, old.id, next(old, 1)); return run(old.id);
    }
}
