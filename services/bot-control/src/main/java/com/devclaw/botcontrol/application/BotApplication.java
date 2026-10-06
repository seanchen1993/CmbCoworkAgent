package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.domain.CanonicalCommand;
import com.devclaw.botcontrol.persistence.JdbcApplicationStore;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Offline application core. No HTTP, ambient identity or external calls. */
public final class BotApplication {
    private static final long MAX_VERSION = 9007199254740991L;
    private final DataSource source;
    private final IdentityPolicy policy;
    private final TransactionObserver observer;
    private final ContractBoundary boundary = new ContractBoundary();
    public BotApplication(DataSource source, IdentityPolicy policy) { this(source, policy, TransactionObserver.NONE); }
    public BotApplication(DataSource source, IdentityPolicy policy, TransactionObserver observer) {
        if (source == null || policy == null || observer == null) throw new IllegalArgumentException("APPLICATION_CONSTRUCTION");
        this.source = source; this.policy = policy; this.observer = observer;
    }
    public ApplicationResponse execute(Operation operation, TrustedContext actor, String pathId, byte[] originalBytes) {
        if (operation == null) throw new IllegalArgumentException("APPLICATION_SELECTION");
        try {
            if (originalBytes != null && originalBytes.length > 1048576) throw new ApplicationFault(operation.write() ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.INVALID_PAYLOAD);
            if (actor == null || actor.principalId == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
            boundary.validateParameter(operation.wire, "X-DevClaw-Space", actor.spaceId);
            // Same frozen Id definition, not a new identity syntax.
            boundary.validateParameter("getBot", "botId", actor.principalId);
            if (operation.create()) { if (pathId != null) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); }
            else boundary.validateParameter(operation.wire, operation.bot() ? "botId" : "groupId", pathId);
            Object input = request(operation, originalBytes);
            if (!policy.activeMember(actor.spaceId, actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
            if (operation == Operation.CREATE_BOT && !policy.mayCreateBot(actor)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
            if (operation == Operation.CREATE_GROUP && !policy.mayCreateGroup(actor)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
            return transaction(operation, actor, pathId, input);
        } catch (ApplicationFault failure) { return error(operation, failure); }
        catch (ContractBoundary.Failure failure) {
            return error(operation, new ApplicationFault(failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD));
        } catch (RuntimeException failure) { return error(operation, new ApplicationFault(ErrorCode.DEPENDENCY_UNAVAILABLE)); }
    }
    private Object request(Operation op, byte[] bytes) {
        switch (op) {
            case CREATE_BOT: return boundary.readRequest(op.wire, bytes, CreateBotRequest.class);
            case CREATE_BOT_VERSION: return boundary.readRequest(op.wire, bytes, CreateBotVersionRequest.class);
            case CREATE_GROUP: return boundary.readRequest(op.wire, bytes, CreateGroupRequest.class);
            case UPDATE_GROUP_MEMBERS: return boundary.readRequest(op.wire, bytes, UpdateGroupMembersRequest.class);
            default: if (bytes != null && bytes.length != 0) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); return null;
        }
    }
    private static String command(Object input) {
        if (input instanceof CreateBotRequest) return ((CreateBotRequest)input).commandId;
        if (input instanceof CreateBotVersionRequest) return ((CreateBotVersionRequest)input).commandId;
        if (input instanceof CreateGroupRequest) return ((CreateGroupRequest)input).commandId;
        return ((UpdateGroupMembersRequest)input).commandId;
    }
    private ApplicationResponse transaction(Operation op, TrustedContext actor, String id, Object input) {
        boolean commitAttempted = false;
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED); c.setAutoCommit(false);
            try {
                JdbcApplicationStore db = new JdbcApplicationStore(c, actor.spaceId, observer);
                if (op.write()) { observer.reached(TransactionObserver.Stage.BEFORE_SCOPE); db.lockScope(actor.principalId); observer.reached(TransactionObserver.Stage.SCOPE_LOCKED); }
                // DB UTC is read after command serialization, once per transaction.
                Timestamp now = db.now();
                Bot bot = null; Group group = null;
                if (!op.create()) {
                    if (op.bot()) { bot = requireBot(db, id, false); authorizeBot(actor, bot); }
                    else { group = requireGroup(db, id, false); authorizeGroup(actor, group, op.write()); }
                }
                JdbcApplicationStore.Receipt receipt = op.write() ? db.receipt(actor.principalId, command(input)) : null;
                if (receipt != null) {
                    if (op.create()) authorizeReceiptTarget(db, actor, receipt);
                    if (!now.before(receipt.expires)) throw new ApplicationFault(ErrorCode.COMMAND_EXPIRED);
                    byte[] fingerprint = CanonicalCommand.fingerprint(actor, op, id, input);
                    if (!op.wire.equals(receipt.operation) || !MessageDigest.isEqual(fingerprint, receipt.fingerprint)) throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                    verifyReceipt(db, op, actor, id, receipt);
                    c.commit(); return new ApplicationResponse(receipt.status, receipt.body);
                }
                Object result;
                String receiptType = null, receiptTarget = null, targetType = null, targetId = null; long targetVersion = 0;
                switch (op) {
                    case CREATE_BOT: {
                        CreateBotRequest r = (CreateBotRequest)input; maintainers(actor, r.maintainerIds); config(actor, r.config);
                        bot = new Bot(); bot.id = newId(); bot.spaceId = actor.spaceId; bot.version = 1L; bot.name = r.name; bot.status = BotStatus.ACTIVE;
                        bot.createdAt = bot.updatedAt = JdbcApplicationStore.text(now); bot.maintainerIds = r.maintainerIds;
                        BotVersion version = newVersion(actor, bot.id, 1L, r.config, now); bot.currentBotVersionId = version.id;
                        db.createBot(bot, version); result = botResult(bot, version); receiptType = targetType = "bot"; receiptTarget = targetId = bot.id; targetVersion = 1; break;
                    }
                    case GET_BOT: result = botResult(bot, current(db, bot)); break;
                    case CREATE_BOT_VERSION: {
                        CreateBotVersionRequest r = (CreateBotVersionRequest)input; BotVersion previous = current(db, bot);
                        cas(bot.version, r.expectedVersion); if (bot.status != BotStatus.ACTIVE) throw new ApplicationFault(ErrorCode.FORBIDDEN); config(actor, r.config);
                        long next = increment(bot.version), number = increment(previous.number);
                        BotVersion version = newVersion(actor, bot.id, number, r.config, now); db.appendVersion(version);
                        bot.version = next; bot.currentBotVersionId = version.id; bot.updatedAt = JdbcApplicationStore.text(now); db.advanceBot(bot, r.expectedVersion);
                        result = botResult(bot, version); receiptType = "bot_version"; receiptTarget = version.id; targetType = "bot"; targetId = bot.id; targetVersion = next; break;
                    }
                    case CREATE_GROUP: {
                        CreateGroupRequest r = (CreateGroupRequest)input; members(actor, r.members, true); bindings(db, actor, r.bots, Collections.emptyList(), true);
                        group = new Group(); group.id = newId(); group.spaceId = actor.spaceId; group.version = 1L; group.name = r.name; group.limits = r.limits;
                        group.createdAt = group.updatedAt = JdbcApplicationStore.text(now); group.members = r.members; group.bots = r.bots;
                        db.createGroup(group); result = groupResult(group); receiptType = targetType = "group"; receiptTarget = targetId = group.id; targetVersion = 1; break;
                    }
                    case GET_GROUP: bindings(db, actor, group.bots, group.bots, false); result = groupResult(group); break;
                    case UPDATE_GROUP_MEMBERS: {
                        UpdateGroupMembersRequest r = (UpdateGroupMembersRequest)input; cas(group.version, r.expectedVersion);
                        members(actor, r.members, false); bindings(db, actor, r.bots, group.bots, true);
                        int oldMembers = group.members.size(), oldBots = group.bots.size(); group.version = increment(group.version); group.updatedAt = JdbcApplicationStore.text(now);
                        group.members = r.members; group.bots = r.bots; db.replaceGroup(group, r.expectedVersion, oldMembers, oldBots);
                        result = groupResult(group); receiptType = targetType = "group"; receiptTarget = targetId = group.id; targetVersion = group.version; break;
                    }
                    default: throw new AssertionError();
                }
                byte[] body;
                try { body = boundary.writeResponse(op.wire, op.success, result); }
                catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
                if (op.write()) {
                    observer.reached(TransactionObserver.Stage.BEFORE_RECEIPT);
                    db.record(actor.principalId, command(input), op.wire, receiptType, receiptTarget, CanonicalCommand.fingerprint(actor, op, id, input), op.success, body, targetType, targetId, targetVersion, now);
                    observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);
                }
                commitAttempted = true; c.commit(); if (op.write()) observer.reached(TransactionObserver.Stage.AFTER_COMMIT);
                return new ApplicationResponse(op.success, body);
            } catch (SQLException | RuntimeException failure) {
                if (!commitAttempted) { try { c.rollback(); } catch (SQLException ignored) { /* still fail closed */ } }
                if (commitAttempted && op.write()) throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);
                if (failure instanceof ApplicationFault) throw (ApplicationFault)failure;
                throw JdbcApplicationStore.corrupt();
            }
        } catch (SQLException failure) { throw new ApplicationFault(commitAttempted && op.write() ? ErrorCode.OUTCOME_UNKNOWN : ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private void authorizeReceiptTarget(JdbcApplicationStore db, TrustedContext actor, JdbcApplicationStore.Receipt receipt) throws SQLException {
        if ("bot".equals(receipt.type)) authorizeBot(actor, requireBot(db, receipt.target, true));
        else if ("bot_version".equals(receipt.type)) authorizeBot(actor, requireBot(db, db.versionOwner(receipt.target), true));
        else if ("group".equals(receipt.type)) authorizeGroup(actor, requireGroup(db, receipt.target, true), true);
        else throw JdbcApplicationStore.corrupt();
    }
    private void verifyReceipt(JdbcApplicationStore db, Operation op, TrustedContext actor, String pathId, JdbcApplicationStore.Receipt r) throws SQLException {
        if (r.status != op.success) throw JdbcApplicationStore.corrupt();
        try {
            if (op.bot()) {
                BotResult result = boundary.readResponse(op.wire, r.status, r.body, BotResult.class); Bot b = result.bot; BotVersion v = result.botVersion;
                if (!actor.spaceId.equals(b.spaceId) || !actor.spaceId.equals(v.spaceId) || !b.id.equals(v.botId) || !b.currentBotVersionId.equals(v.id)) throw JdbcApplicationStore.corrupt();
                if (op == Operation.CREATE_BOT ? !"bot".equals(r.type) || !r.target.equals(b.id) : !"bot_version".equals(r.type) || !r.target.equals(v.id) || !pathId.equals(b.id)) throw JdbcApplicationStore.corrupt();
                BotVersion stored = db.version(v.id);
                if (stored == null || !Arrays.equals(JdbcApplicationStore.json(stored), JdbcApplicationStore.json(v))) throw JdbcApplicationStore.corrupt();
                Bot currentBot = requireBot(db, b.id, true); current(db, currentBot);
                if (!b.version.equals(v.number) || !b.name.equals(currentBot.name) || !b.createdAt.equals(currentBot.createdAt)) throw JdbcApplicationStore.corrupt();
            } else {
                GroupResult result = boundary.readResponse(op.wire, r.status, r.body, GroupResult.class); Group g = result.group;
                if (!"group".equals(r.type) || !r.target.equals(g.id) || !actor.spaceId.equals(g.spaceId) || (pathId != null && !pathId.equals(g.id))) throw JdbcApplicationStore.corrupt();
                Group stored = requireGroup(db, g.id, true);
                if (!g.name.equals(stored.name) || !g.createdAt.equals(stored.createdAt) || !Arrays.equals(JdbcApplicationStore.json(g.limits), JdbcApplicationStore.json(stored.limits))) throw JdbcApplicationStore.corrupt();
                bindings(db, actor, g.bots, g.bots, false);
            }
        } catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
    }
    private Bot requireBot(JdbcApplicationStore db, String id, boolean receipt) throws SQLException {
        Bot b = db.bot(id); if (b == null) throw receipt ? JdbcApplicationStore.corrupt() : new ApplicationFault(ErrorCode.NOT_FOUND); validVersion(b.version); return b;
    }
    private Group requireGroup(JdbcApplicationStore db, String id, boolean receipt) throws SQLException {
        Group g = db.group(id); if (g == null) throw receipt ? JdbcApplicationStore.corrupt() : new ApplicationFault(ErrorCode.NOT_FOUND); validVersion(g.version); return g;
    }
    private static BotVersion current(JdbcApplicationStore db, Bot b) throws SQLException {
        BotVersion v = db.version(b.currentBotVersionId);
        if (v == null || !b.id.equals(v.botId) || !b.spaceId.equals(v.spaceId)) throw JdbcApplicationStore.corrupt();
        validVersion(v.number); if (!v.number.equals(b.version) || db.latestVersionNumber(b.id) != v.number) throw JdbcApplicationStore.corrupt(); return v;
    }
    private static void authorizeBot(TrustedContext actor, Bot b) { if (!b.maintainerIds.contains(actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN); }
    private static void authorizeGroup(TrustedContext actor, Group g, boolean admin) {
        for (GroupMember m : g.members) if (actor.principalId.equals(m.principalId) && (!admin || m.role == GroupMemberRole.ADMIN)) return;
        throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private void maintainers(TrustedContext actor, List<String> ids) {
        if (new HashSet<>(ids).size() != ids.size()) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        if (!ids.contains(actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        for (String id : ids) if (!policy.activeMember(actor.spaceId, id)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private void members(TrustedContext actor, List<GroupMember> values, boolean create) {
        Set<String> seen = new HashSet<>(); boolean admin = false, selfAdmin = false;
        for (GroupMember m : values) {
            if (!seen.add(m.principalId)) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
            if (!policy.activeMember(actor.spaceId, m.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
            if (m.role == GroupMemberRole.ADMIN) { admin = true; selfAdmin |= actor.principalId.equals(m.principalId); }
        }
        if (!admin) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        if (create && !selfAdmin) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private void config(TrustedContext actor, BotConfig config) {
        for (String id : config.knowledgeRefs) if (!policy.mayAssociate(actor, IdentityPolicy.Reference.KNOWLEDGE, id)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        for (String id : config.repositoryRefs) if (!policy.mayAssociate(actor, IdentityPolicy.Reference.REPOSITORY, id)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        for (String id : config.skillAllowlist) if (!policy.mayAssociate(actor, IdentityPolicy.Reference.SKILL, id)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
        for (Capability capability : config.capabilityCeiling) if (!policy.mayConfigure(actor, capability)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private void bindings(JdbcApplicationStore db, TrustedContext actor, List<GroupBot> values, List<GroupBot> previous, boolean writing) throws SQLException {
        Map<String, GroupBot> old = new HashMap<>(); for (GroupBot b : previous) old.put(b.botId, b);
        TreeMap<String, GroupBot> ordered = new TreeMap<>();
        for (GroupBot b : values) if (ordered.put(b.botId, b) != null) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        Map<String, Bot> bots = new HashMap<>(); TreeSet<String> versionIds = new TreeSet<>();
        // Group parent -> ALL ordered Bot parents -> ALL ordered BotVersion rows.
        for (GroupBot b : ordered.values()) { Bot bot = db.bot(b.botId); if (bot == null) throw writing ? new ApplicationFault(ErrorCode.INVALID_PAYLOAD) : JdbcApplicationStore.corrupt(); validVersion(bot.version); bots.put(b.botId, bot); versionIds.add(bot.currentBotVersionId); versionIds.add(b.botVersionId); }
        Map<String, BotVersion> versions = new HashMap<>(); for (String id : versionIds) versions.put(id, db.version(id));
        for (GroupBot b : ordered.values()) {
            Bot bot = bots.get(b.botId); BotVersion current = versions.get(bot.currentBotVersionId), selected = versions.get(b.botVersionId);
            if (current == null || !bot.id.equals(current.botId) || !actor.spaceId.equals(current.spaceId)) throw JdbcApplicationStore.corrupt();
            validVersion(current.number); if (!bot.version.equals(current.number) || db.latestVersionNumber(bot.id) != current.number) throw JdbcApplicationStore.corrupt();
            if (selected == null || !bot.id.equals(selected.botId) || !actor.spaceId.equals(selected.spaceId)) throw writing ? new ApplicationFault(ErrorCode.INVALID_PAYLOAD) : JdbcApplicationStore.corrupt();
            validVersion(selected.number);
            GroupBot before = old.get(b.botId);
            boolean changed = before == null || !before.botVersionId.equals(b.botVersionId);
            if (writing && changed) { if (bot.status != BotStatus.ACTIVE) throw new ApplicationFault(ErrorCode.FORBIDDEN); authorizeBot(actor, bot); }
        }
    }
    private static void cas(Long actual, Long expected) { if (!actual.equals(expected)) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, actual); }
    private static void validVersion(Long version) { if (version == null || version < 1 || version > MAX_VERSION) throw JdbcApplicationStore.corrupt(); }
    private static long increment(Long version) { validVersion(version); if (version == MAX_VERSION) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, version); return version + 1; }
    private static String newId() { return UUID.randomUUID().toString(); }
    private static BotVersion newVersion(TrustedContext actor, String bot, Long number, BotConfig config, Timestamp time) {
        BotVersion v = new BotVersion(); v.id = newId(); v.botId = bot; v.spaceId = actor.spaceId; v.number = number; v.config = config; v.createdAt = JdbcApplicationStore.text(time); return v;
    }
    private static BotResult botResult(Bot b, BotVersion v) { BotResult r = new BotResult(); r.bot = b; r.botVersion = v; return r; }
    private static GroupResult groupResult(Group g) { GroupResult r = new GroupResult(); r.group = g; return r; }
    private ApplicationResponse error(Operation op, ApplicationFault failure) {
        ErrorCode code = failure.code;
        Long currentVersion = failure.currentVersion;
        int status;
        switch (code) {
            case INVALID_PAYLOAD: status = 400; break;
            case UNAUTHENTICATED: status = 401; break;
            case FORBIDDEN: status = 403; break;
            case NOT_FOUND: status = 404; break;
            case VERSION_CONFLICT: case COMMAND_CONFLICT: case COMMAND_EXPIRED: case OUTCOME_UNKNOWN: status = 409; break;
            case PAYLOAD_TOO_LARGE: status = 413; break;
            default: status = 503; code = ErrorCode.DEPENDENCY_UNAVAILABLE;
        }
        // Trusted ports may fail, but cannot manufacture an undeclared selector/status.
        if ((status == 409 && !op.write()) || (status == 404 && op.create()) ||
            (currentVersion != null && (currentVersion < 1 || currentVersion > MAX_VERSION))) {
            status = 503; code = ErrorCode.DEPENDENCY_UNAVAILABLE; currentVersion = null;
        }
        if (status == 413 && !op.write()) { status = 400; code = ErrorCode.INVALID_PAYLOAD; }
        ErrorResponse r = new ErrorResponse(); r.requestId = newId(); r.error = new ErrorResponseError();
        r.error.code = code; r.error.message = code.wire(); r.error.retryable = false; r.error.currentVersion = currentVersion;
        return new ApplicationResponse(status, boundary.writeResponse(op.wire, status, r));
    }
}
