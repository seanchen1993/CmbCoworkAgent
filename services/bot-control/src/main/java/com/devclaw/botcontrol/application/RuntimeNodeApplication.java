package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.persistence.JdbcRuntimeNodeStore.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import javax.sql.DataSource;

/** Internal requirement-only node/grant boundary, intentionally not HTTP wired.
 * READY is an expiring authorization observation, not a Run, lease or permission
 * to execute. Future dispatch/start must revalidate versions and current ACLs. */
public final class RuntimeNodeApplication {
    public static final long HEARTBEAT_TTL_MILLIS = 60000, MAX_GRANT_MILLIS = 604800000;
    private final DataSource source; private final IdentityPolicy identity; private final RuntimeAccessPolicy access; private final TransactionObserver observer;
    private final ContractBoundary boundary = new ContractBoundary();
    public RuntimeNodeApplication(DataSource source, IdentityPolicy identity, RuntimeAccessPolicy access, TransactionObserver observer) {
        if (source == null || identity == null || access == null || observer == null) throw new IllegalArgumentException("APPLICATION_CONSTRUCTION");
        this.source = source; this.identity = identity; this.access = access; this.observer = observer;
    }
    private void id(String value) { boundary.validateParameter("getBot", "botId", value); }
    private void actor(TrustedContext actor) {
        if (actor == null || actor.principalId == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
        boundary.validateParameter("getBot", "X-DevClaw-Space", actor.spaceId); id(actor.principalId);
        if (!identity.activeMember(actor.spaceId, actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private static void expected(long version) { if (version < 0 || version > JdbcTaskStore.MAX) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); }
    private void use(TrustedContext actor, String workspace) {
        if (!access.mayUseCapability(actor, Capability.REQUIREMENTS_ANALYZE) || !access.mayUseWorkspace(actor, workspace)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private static void cas(Grant grant, long expected) {
        long current = grant == null ? 0 : grant.version;
        if (expected != current) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, current);
    }
    private static Group group(JdbcApplicationStore db, TrustedContext actor, String id, boolean admin) throws SQLException {
        Group g = db.group(id); if (g == null) throw new ApplicationFault(ErrorCode.NOT_FOUND);
        if (!ReceiptAccess.member(actor, g, admin)) throw new ApplicationFault(ErrorCode.FORBIDDEN); return g;
    }
    private interface Work<T> { T run(Connection c, JdbcApplicationStore db, JdbcRuntimeNodeStore nodes) throws SQLException; }
    private <T> T transaction(String space, boolean write, Work<T> work) {
        boolean commitAttempted = false;
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED); c.setAutoCommit(false);
            try {
                T result = work.run(c, new JdbcApplicationStore(c, space, observer), new JdbcRuntimeNodeStore(c, space));
                if (write) observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);
                commitAttempted = true; c.commit();
                if (write) observer.reached(TransactionObserver.Stage.AFTER_COMMIT); return result;
            } catch (SQLException | RuntimeException failure) {
                if (!commitAttempted) try { c.rollback(); } catch (SQLException ignored) { /* no safe result */ }
                if (commitAttempted && write) throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);
                if (failure instanceof ApplicationFault) throw (ApplicationFault)failure;
                throw JdbcApplicationStore.corrupt();
            }
        } catch (SQLException failure) { throw new ApplicationFault(commitAttempted && write ? ErrorCode.OUTCOME_UNKNOWN : ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private interface Call<T> { T run(); }
    private <T> T safe(Call<T> call) {
        try { return call.run(); }
        catch (ApplicationFault failure) { throw failure; }
        catch (ContractBoundary.Failure failure) { throw new ApplicationFault(failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD); }
        catch (RuntimeException failure) { throw JdbcApplicationStore.corrupt(); }
    }
    public Node observeDesktopNode(TrustedNodeContext node, boolean supportsRequirement, Set<Capability> capabilities) {
        return safe(() -> {
            if (node == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
            TrustedContext owner = new TrustedContext(node.spaceId, node.ownerPrincipalId); actor(owner); id(node.nodeId);
            if (capabilities == null || capabilities.contains(null) || capabilities.size() > Capability.values().length) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
            final Set<Capability> frozen = capabilities.isEmpty() ? EnumSet.noneOf(Capability.class) : EnumSet.copyOf(capabilities);
            return transaction(node.spaceId, true, (c, db, nodes) -> {
                nodes.ensureNode(node.nodeId, owner.principalId, supportsRequirement, frozen);
                Node current = nodes.node(node.nodeId);
                if (!owner.principalId.equals(current.ownerPrincipalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                return nodes.observe(current, supportsRequirement, frozen, db.now().toInstant());
            });
        });
    }
    public Grant authorizeRequirementNode(TrustedContext owner, String groupId, String nodeId, String workspaceRef, long expectedVersion, Instant expiresAt) {
        return safe(() -> {
            actor(owner); id(groupId); id(nodeId); id(workspaceRef); expected(expectedVersion);
            if (expiresAt == null || expiresAt.getNano() % 1000000 != 0) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
            return transaction(owner.spaceId, true, (c, db, nodes) -> {
                group(db, owner, groupId, true); Grant old = nodes.grant(groupId); Node node = nodes.node(nodeId);
                if (node == null) throw new ApplicationFault(ErrorCode.NOT_FOUND);
                if (!owner.principalId.equals(node.ownerPrincipalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                use(owner, workspaceRef);
                if (!node.supportsRequirement || !node.capabilities.contains(Capability.REQUIREMENTS_ANALYZE)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                cas(old, expectedVersion); Instant now = db.now().toInstant();
                if (!expiresAt.isAfter(now) || expiresAt.isAfter(now.plusMillis(MAX_GRANT_MILLIS))) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
                return nodes.authorize(old, groupId, nodeId, owner.principalId, workspaceRef, expiresAt, now);
            });
        });
    }
    public Grant revokeRequirementNode(TrustedContext actor, String groupId, long expectedVersion) {
        return safe(() -> {
            actor(actor); id(groupId); expected(expectedVersion);
            return transaction(actor.spaceId, true, (c, db, nodes) -> {
                group(db, actor, groupId, true); Grant old = nodes.grant(groupId);
                if (old == null) throw new ApplicationFault(ErrorCode.NOT_FOUND); cas(old, expectedVersion);
                return nodes.revoke(old, db.now().toInstant());
            });
        });
    }
    public enum DispatchStatus { READY, WAITING_NODE }
    public static final class RequirementDispatch {
        public final DispatchStatus status;
        public final String spaceId, requesterPrincipalId, ownerPrincipalId, taskId, stageId, groupId, botId, botVersionId, nodeId, grantId, workspaceRef;
        public final long taskVersion, groupVersion, nodeVersion, grantVersion;
        public final Instant observedAt, validUntil;
        public final Capability capability = Capability.REQUIREMENTS_ANALYZE;
        public final boolean readOnly = true;
        private RequirementDispatch(DispatchStatus status, TrustedContext actor, Task task, Group group, GroupBot bot, Node node, Grant grant, Instant now) {
            this.status = status; spaceId = actor.spaceId; requesterPrincipalId = actor.principalId; ownerPrincipalId = grant.ownerPrincipalId;
            taskId = task.id; taskVersion = task.version; stageId = task.currentStageId; groupId = group.id; groupVersion = group.version;
            botId = bot.botId; botVersionId = bot.botVersionId; nodeId = node.id; nodeVersion = node.version; grantId = grant.id; grantVersion = grant.version; workspaceRef = grant.workspaceRef;
            observedAt = now; Instant heartbeatExpiry = node.lastSeenAt.plusMillis(HEARTBEAT_TTL_MILLIS); validUntil = grant.expiresAt.isBefore(heartbeatExpiry) ? grant.expiresAt : heartbeatExpiry;
        }
    }
    public RequirementDispatch resolveRequirementDispatch(TrustedContext requester, String taskId, String botId) {
        // Locks protect this observation only. Never start an executor from a
        // retained READY value: membership/ACL, grant and node can change later.
        return safe(() -> {
            actor(requester); id(taskId); id(botId);
            return transaction(requester.spaceId, false, (c, db, nodes) -> {
                JdbcTaskStore tasks = new JdbcTaskStore(c, requester.spaceId); String groupId = tasks.groupId(taskId);
                if (groupId == null) throw new ApplicationFault(ErrorCode.NOT_FOUND);
                Group g = group(db, requester, groupId, false); Task t = tasks.task(taskId);
                if (t == null || !g.id.equals(t.groupId)) throw JdbcApplicationStore.corrupt();
                Stage stage = null; for (Stage s : t.stages) if (s.id.equals(t.currentStageId)) { if (stage != null) throw JdbcApplicationStore.corrupt(); stage = s; }
                if (t.status != TaskStatus.ACTIVE || stage == null || stage.kind != StageKind.REQUIREMENT || stage.status != StageStatus.ACTIVE) throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
                GroupBot binding = null; for (GroupBot b : g.bots) if (botId.equals(b.botId)) binding = b;
                if (binding == null) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                Bot bot = db.bot(botId); BotVersion version = db.version(binding.botVersionId);
                if (bot == null || version == null || !botId.equals(version.botId) || !requester.spaceId.equals(version.spaceId)) throw JdbcApplicationStore.corrupt();
                if (bot.status != BotStatus.ACTIVE || !version.config.capabilityCeiling.contains(Capability.REQUIREMENTS_ANALYZE)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                Grant grant = nodes.grant(g.id);
                if (grant == null || !grant.enabled) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                TrustedContext owner = new TrustedContext(requester.spaceId, grant.ownerPrincipalId); actor(owner);
                if (!ReceiptAccess.member(owner, g, true)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                use(owner, grant.workspaceRef); use(requester, grant.workspaceRef);
                Node node = nodes.node(grant.nodeId);
                if (node == null || !grant.ownerPrincipalId.equals(node.ownerPrincipalId)) throw JdbcApplicationStore.corrupt();
                if (!node.supportsRequirement || !node.capabilities.contains(Capability.REQUIREMENTS_ANALYZE)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                Instant now = db.now().toInstant();
                if (!now.isBefore(grant.expiresAt)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                DispatchStatus status = !node.lastSeenAt.isAfter(now) && now.isBefore(node.lastSeenAt.plusMillis(HEARTBEAT_TTL_MILLIS)) ? DispatchStatus.READY : DispatchStatus.WAITING_NODE;
                return new RequirementDispatch(status, requester, t, g, binding, node, grant, now);
            });
        });
    }
}
