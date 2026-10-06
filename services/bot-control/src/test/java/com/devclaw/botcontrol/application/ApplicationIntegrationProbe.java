package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.*;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;

/** Test main only: fixed disposable-fixture SQL, never an application endpoint. */
public final class ApplicationIntegrationProbe {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    private static final TrustedContext P1 = new TrustedContext("A", "p1"), P2 = new TrustedContext("A", "p2"), P3 = new TrustedContext("A", "p3"), P4 = new TrustedContext("A", "p4");
    private static final String[] TABLES = {"bots", "bot_versions", "bot_maintainers", "groups", "group_members", "group_bots", "command_scope", "command_receipts", "mutation_outbox"};
    private static final String[] ORDER = {"space_id,id", "space_id,id", "space_id,bot_id,principal_id", "space_id,id", "space_id,group_id,principal_id", "space_id,group_id,bot_id", "space_id,principal_id", "space_id,principal_id,command_id", "space_id,id"};
    private static String stage = "configuration";
    private static int assertions, denials, replayChecks, rollbackChecks, corruptChecks;
    private static final ArrayNode responses = JSON.createArrayNode();
    private static void check(boolean value) { assertions++; if (!value) throw new AssertionError("C1_PROBE_ASSERTION"); }
    private static IdentityPolicy policy(boolean references) {
        return new IdentityPolicy() {
            public boolean activeMember(String s, String p) { return s.equals("B") && p.equals("foreign") || Arrays.asList("A", "B", "race").contains(s) && Arrays.asList("p1", "p2", "p3", "p4", "p9").contains(p); }
            public boolean mayCreateBot(TrustedContext a) { return !a.principalId.equals("p3"); }
            public boolean mayCreateGroup(TrustedContext a) { return !a.principalId.equals("p3"); }
            public boolean mayAssociate(TrustedContext a, Reference k, String id) { return references && id.equals("allowed"); }
            public boolean mayConfigure(TrustedContext a, Capability c) { return references && c == Capability.REPOSITORY_READ; }
        };
    }
    private static byte[] bytes(Object value) { return JdbcApplicationStore.json(value); }
    private static BotConfig config() {
        BotConfig c = new BotConfig(); c.description = "中文🚀\u0000\ud800"; c.instructions = "instructions\udc00";
        c.knowledgeRefs = Arrays.asList("allowed"); c.repositoryRefs = Arrays.asList("allowed"); c.skillAllowlist = Arrays.asList("allowed");
        c.capabilityCeiling = Arrays.asList(Capability.REPOSITORY_READ); c.memoryPolicy = BotConfigMemoryPolicy.EXPLICIT_ONLY; return c;
    }
    private static CreateBotRequest create(String command) { CreateBotRequest r = new CreateBotRequest(); r.commandId = command; r.name = "中文🚀x\u0000\ud800y\udc00"; r.config = config(); r.maintainerIds = Arrays.asList("p2", "p1"); return r; }
    private static CreateBotVersionRequest append(String command, long version) { CreateBotVersionRequest r = new CreateBotVersionRequest(); r.commandId = command; r.expectedVersion = version; r.config = config(); return r; }
    private static GroupMember member(String id, GroupMemberRole role) { GroupMember m = new GroupMember(); m.principalId = id; m.role = role; return m; }
    private static GroupBot binding(String id, String version) { GroupBot b = new GroupBot(); b.botId = id; b.botVersionId = version; b.role = GroupBotRole.SPECIALIST; return b; }
    private static List<GroupMember> members() { return Arrays.asList(member("p4", GroupMemberRole.ADMIN), member("p1", GroupMemberRole.ADMIN), member("p3", GroupMemberRole.PARTICIPANT)); }
    private static CreateGroupRequest group(String command, BotResult bot) {
        CreateGroupRequest r = new CreateGroupRequest(); r.commandId = command; r.name = "群🚀\u0000\ud800\udc00"; r.members = members(); r.bots = Arrays.asList(binding(bot.bot.id, bot.botVersion.id));
        r.limits = new GroupLimits(); r.limits.maxHandoffs = 2L; r.limits.maxRuns = 3L; r.limits.maxTokens = 4L; return r;
    }
    private static UpdateGroupMembersRequest update(String command, long version, List<GroupMember> members, List<GroupBot> bots) {
        UpdateGroupMembersRequest r = new UpdateGroupMembersRequest(); r.commandId = command; r.expectedVersion = version; r.members = members; r.bots = bots; return r;
    }
    private static ApplicationResponse call(BotApplication app, Operation op, TrustedContext actor, String id, Object request) {
        return app.execute(op, actor, id, request == null ? null : bytes(request));
    }
    private static BotResult bot(ApplicationResponse r, Operation op) { check(r.status == op.success); return BOUNDARY.readResponse(op.wire, r.status, r.body(), BotResult.class); }
    private static GroupResult group(ApplicationResponse r, Operation op) { check(r.status == op.success); return BOUNDARY.readResponse(op.wire, r.status, r.body(), GroupResult.class); }
    private static void collect(Operation op, ApplicationResponse response) {
        ObjectNode item = responses.addObject(); item.put("operation", op.wire); item.put("status", response.status); item.put("body", Base64.getEncoder().encodeToString(response.body()));
    }
    private static void error(ApplicationResponse r, Operation op, ErrorCode code, int status) { check(r.status == status); ErrorResponse body = BOUNDARY.readResponse(op.wire, r.status, r.body(), ErrorResponse.class); check(body.error.code == code); check(!body.error.retryable); }
    private static byte[] facts(HikariDataSource source) throws Exception {
        ByteArrayOutputStream data = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(data);
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ); c.setAutoCommit(false);
            for (int i = 0; i < TABLES.length; i++) {
                out.writeUTF(TABLES[i]);
                try (PreparedStatement p = c.prepareStatement("SELECT * FROM " + TABLES[i] + " ORDER BY " + ORDER[i])) {
                    p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) {
                        int n = r.getMetaData().getColumnCount();
                        while (r.next()) { out.writeBoolean(true); for (int j = 1; j <= n; j++) { Object value = r.getObject(j); byte[] b = value instanceof byte[] ? (byte[])value : String.valueOf(value).getBytes(StandardCharsets.UTF_8); out.writeInt(b.length); out.write(b); } }
                    }
                }
                out.writeBoolean(false);
            }
            c.rollback();
        }
        out.close(); return data.toByteArray();
    }
    private static void denied(HikariDataSource source, BotApplication app, Operation op, TrustedContext actor, String id, Object request, ErrorCode code, int status) throws Exception {
        byte[] before = facts(source); error(call(app, op, actor, id, request), op, code, status); check(Arrays.equals(before, facts(source))); denials++;
    }
    private static void replay(HikariDataSource source, BotApplication app, Operation op, TrustedContext actor, String id, Object request, ApplicationResponse original) throws Exception {
        byte[] before = facts(source); ApplicationResponse r = call(app, op, actor, id, request); check(r.status == original.status); check(Arrays.equals(r.body(), original.body())); check(Arrays.equals(before, facts(source))); replayChecks++;
    }
    private static JsonNode reverseKeys(JsonNode value) {
        if (value.isObject()) {
            ObjectNode result = JSON.createObjectNode(); List<String> keys = new ArrayList<>(); value.fieldNames().forEachRemaining(keys::add); Collections.reverse(keys);
            for (String key : keys) result.set(key, reverseKeys(value.get(key))); return result;
        }
        if (value.isArray()) { ArrayNode result = JSON.createArrayNode(); for (JsonNode child : value) result.add(reverseKeys(child)); return result; }
        return value;
    }
    private static void canonicalReplay(HikariDataSource source, BotApplication app, Operation op, TrustedContext actor, String id, Object request, ApplicationResponse original) throws Exception {
        String reordered = new String(bytes(reverseKeys(JSON.readTree(bytes(request)))), StandardCharsets.UTF_8);
        for (String integer : Arrays.asList("1", "1.0", "1e0")) {
            byte[] before = facts(source); byte[] raw = reordered.replace("\"expectedVersion\":1", "\"expectedVersion\":" + integer).getBytes(StandardCharsets.UTF_8);
            ApplicationResponse result = app.execute(op, actor, id, raw); check(result.status == original.status); check(Arrays.equals(original.body(), result.body())); check(Arrays.equals(before, facts(source))); replayChecks++;
        }
    }
    private static void edit(HikariDataSource source, String sql, Object... values) throws Exception {
        try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement(sql)) {
            p.setQueryTimeout(2); for (int i = 0; i < values.length; i++) if (values[i] instanceof byte[]) p.setBytes(i + 1, (byte[])values[i]); else p.setObject(i + 1, values[i]);
            check(p.executeUpdate() == 1);
        }
    }
    private static void rollback(HikariDataSource source, Operation op, TrustedContext actor, String id, Object input, TransactionObserver.Stage injection) throws Exception {
        byte[] before = facts(source); BotApplication app = new BotApplication(source, policy(true), reached -> { if (reached == injection) throw new IllegalStateException("TEST_FAILURE"); });
        error(call(app, op, actor, id, input), op, ErrorCode.DEPENDENCY_UNAVAILABLE, 503); check(Arrays.equals(before, facts(source))); rollbackChecks++;
    }
    private static void corruptReceipt(HikariDataSource source, BotApplication app, Operation op, String command, String id, Object request, ApplicationResponse original, java.util.function.Consumer<ObjectNode> mutation) throws Exception {
        ObjectNode changed = (ObjectNode)JSON.readTree(original.body()); mutation.accept(changed);
        edit(source, "UPDATE command_receipts SET body_bytes=? WHERE space_id='A' AND principal_id='p1' AND command_id=?", bytes(changed), command);
        denied(source, app, op, P1, id, request, ErrorCode.DEPENDENCY_UNAVAILABLE, 503); corruptChecks++;
        edit(source, "UPDATE command_receipts SET body_bytes=? WHERE space_id='A' AND principal_id='p1' AND command_id=?", original.body(), command);
    }
    private static void suite(HikariDataSource source) throws Exception {
        stage = "six-operations"; BotApplication app = new BotApplication(source, policy(true));
        CreateBotRequest c = create("create"); ApplicationResponse created = call(app, Operation.CREATE_BOT, P1, null, c); collect(Operation.CREATE_BOT, created); BotResult first = bot(created, Operation.CREATE_BOT);
        ApplicationResponse gotBot = call(app, Operation.GET_BOT, P1, first.bot.id, null); collect(Operation.GET_BOT, gotBot); check(Arrays.equals(created.body(), gotBot.body()));
        CreateGroupRequest g = group("group", first); ApplicationResponse createdGroup = call(app, Operation.CREATE_GROUP, P1, null, g); collect(Operation.CREATE_GROUP, createdGroup); GroupResult originalGroup = group(createdGroup, Operation.CREATE_GROUP);
        ApplicationResponse gotGroup = call(app, Operation.GET_GROUP, P3, originalGroup.group.id, null); collect(Operation.GET_GROUP, gotGroup); check(Arrays.equals(createdGroup.body(), gotGroup.body()));
        CreateBotVersionRequest v = append("append", 1); ApplicationResponse appended = call(app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, v); collect(Operation.CREATE_BOT_VERSION, appended); BotResult second = bot(appended, Operation.CREATE_BOT_VERSION);
        check(second.bot.version == 2 && second.botVersion.number == 2 && !first.botVersion.id.equals(second.botVersion.id));
        GroupResult fixed = group(call(app, Operation.GET_GROUP, P4, originalGroup.group.id, null), Operation.GET_GROUP); check(fixed.group.bots.get(0).botVersionId.equals(first.botVersion.id));
        UpdateGroupMembersRequest u = update("update", 1, Arrays.asList(member("p3", GroupMemberRole.PARTICIPANT), member("p1", GroupMemberRole.ADMIN), member("p4", GroupMemberRole.ADMIN)), g.bots);
        ApplicationResponse updated = call(app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, u); collect(Operation.UPDATE_GROUP_MEMBERS, updated); GroupResult changed = group(updated, Operation.UPDATE_GROUP_MEMBERS);
        check(changed.group.name.equals(g.name)); check(Arrays.equals(bytes(changed.group.limits), bytes(g.limits))); check(changed.group.members.get(0).principalId.equals("p3"));

        stage = "replay";
        replay(source, app, Operation.CREATE_BOT, P1, null, c, created); replay(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, v, appended);
        replay(source, app, Operation.CREATE_GROUP, P1, null, g, createdGroup); replay(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, u, updated);
        canonicalReplay(source, app, Operation.CREATE_BOT, P1, null, c, created);
        canonicalReplay(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, v, appended);
        canonicalReplay(source, app, Operation.CREATE_GROUP, P1, null, g, createdGroup);
        canonicalReplay(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, u, updated);
        BotApplication withdrawn = new BotApplication(source, policy(false)); replay(source, withdrawn, Operation.CREATE_BOT, P1, null, c, created); replay(source, withdrawn, Operation.CREATE_BOT_VERSION, P1, first.bot.id, v, appended);
        String integer = new String(bytes(v), StandardCharsets.UTF_8).replace("\"expectedVersion\":1", "\"expectedVersion\":1e0");
        ApplicationResponse numeric = app.execute(Operation.CREATE_BOT_VERSION, P1, first.bot.id, integer.getBytes(StandardCharsets.UTF_8)); check(Arrays.equals(numeric.body(), appended.body()));
        CreateBotRequest conflict = create("create"); conflict.name = "different"; denied(source, app, Operation.CREATE_BOT, P1, null, conflict, ErrorCode.COMMAND_CONFLICT, 409);
        CreateBotRequest opConflict = create("group"); denied(source, app, Operation.CREATE_BOT, P1, null, opConflict, ErrorCode.COMMAND_CONFLICT, 409);
        CreateBotRequest arrayConflict = create("create"); Collections.reverse(arrayConflict.maintainerIds); denied(source, app, Operation.CREATE_BOT, P1, null, arrayConflict, ErrorCode.COMMAND_CONFLICT, 409);
        CreateBotVersionRequest oldCas = append("other-append", 1); denied(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, oldCas, ErrorCode.VERSION_CONFLICT, 409);
        denied(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, append("append", 2), ErrorCode.COMMAND_CONFLICT, 409);
        denied(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("update", 2, u.members, u.bots), ErrorCode.COMMAND_CONFLICT, 409);

        stage = "authorization";
        denied(source, app, Operation.GET_BOT, P3, first.bot.id, null, ErrorCode.FORBIDDEN, 403);
        denied(source, app, Operation.GET_BOT, new TrustedContext("B", "p1"), first.bot.id, null, ErrorCode.NOT_FOUND, 404);
        denied(source, app, Operation.GET_BOT, P1, first.bot.id.toUpperCase(Locale.ROOT), null, ErrorCode.NOT_FOUND, 404);
        denied(source, app, Operation.CREATE_BOT, P3, null, create("no-create"), ErrorCode.FORBIDDEN, 403);
        denied(source, app, Operation.CREATE_BOT, new TrustedContext("A", "disabled"), null, create("disabled"), ErrorCode.FORBIDDEN, 403);
        CreateBotRequest badMaintainer = create("bad-maintainer"); badMaintainer.maintainerIds = Arrays.asList("p1", "foreign"); denied(source, app, Operation.CREATE_BOT, P1, null, badMaintainer, ErrorCode.FORBIDDEN, 403);
        check(policy(true).activeMember("B", "foreign") && !policy(true).activeMember("A", "foreign"));
        badMaintainer.maintainerIds = Arrays.asList("p2"); denied(source, app, Operation.CREATE_BOT, P1, null, badMaintainer, ErrorCode.FORBIDDEN, 403);
        denied(source, withdrawn, Operation.CREATE_BOT_VERSION, P1, first.bot.id, append("no-reference", 2), ErrorCode.FORBIDDEN, 403);
        CreateBotRequest badReference = create("reference"); badReference.config.repositoryRefs = Arrays.asList("unknown"); denied(source, app, Operation.CREATE_BOT, P1, null, badReference, ErrorCode.FORBIDDEN, 403);
        badReference = create("ceiling"); badReference.config.capabilityCeiling = Arrays.asList(Capability.COMMAND_EXECUTE); denied(source, app, Operation.CREATE_BOT, P1, null, badReference, ErrorCode.FORBIDDEN, 403);
        CreateGroupRequest badGroup = group("bad-group", first); badGroup.members = Arrays.asList(member("p1", GroupMemberRole.PARTICIPANT)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        badGroup.members = Arrays.asList(member("p1", GroupMemberRole.ADMIN), member("p1", GroupMemberRole.PARTICIPANT)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        badGroup = group("bad-group", first); badGroup.bots = Arrays.asList(binding(first.bot.id, first.botVersion.id), binding(first.bot.id, second.botVersion.id)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        badGroup = group("bad-group", first); badGroup.bots = Arrays.asList(binding("missing", first.botVersion.id)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        BotResult other = bot(call(app, Operation.CREATE_BOT, P1, null, create("other-bot")), Operation.CREATE_BOT);
        denied(source, app, Operation.CREATE_BOT_VERSION, P1, other.bot.id, v, ErrorCode.COMMAND_CONFLICT, 409);
        CreateGroupRequest otherGroupRequest = group("other-group", first);
        GroupResult otherGroup = group(call(app, Operation.CREATE_GROUP, P1, null, otherGroupRequest), Operation.CREATE_GROUP);
        denied(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, otherGroup.group.id, u, ErrorCode.COMMAND_CONFLICT, 409);
        CreateGroupRequest foreignMember = group("foreign-member", first); foreignMember.members = Arrays.asList(member("p1", GroupMemberRole.ADMIN), member("foreign", GroupMemberRole.PARTICIPANT));
        denied(source, app, Operation.CREATE_GROUP, P1, null, foreignMember, ErrorCode.FORBIDDEN, 403);
        denied(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("not-maintainer", 2, members(), Arrays.asList(binding(first.bot.id, second.botVersion.id))), ErrorCode.FORBIDDEN, 403);
        denied(source, app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("not-maintainer-new", 2, members(), Arrays.asList(binding(other.bot.id, other.botVersion.id))), ErrorCode.FORBIDDEN, 403);
        badGroup.bots = Arrays.asList(binding(first.bot.id, other.botVersion.id)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        BotResult foreign = bot(call(app, Operation.CREATE_BOT, new TrustedContext("B", "p1"), null, create("create")), Operation.CREATE_BOT);
        badGroup.bots = Arrays.asList(binding(foreign.bot.id, foreign.botVersion.id)); denied(source, app, Operation.CREATE_GROUP, P1, null, badGroup, ErrorCode.INVALID_PAYLOAD, 400);
        BotResult otherPrincipal = bot(call(app, Operation.CREATE_BOT, P2, null, create("create")), Operation.CREATE_BOT); check(!otherPrincipal.bot.id.equals(first.bot.id)); check(!foreign.bot.id.equals(first.bot.id));

        stage = "rollback";
        for (TransactionObserver.Stage injection : Arrays.asList(TransactionObserver.Stage.VERSION_WRITTEN, TransactionObserver.Stage.BEFORE_RECEIPT, TransactionObserver.Stage.BEFORE_COMMIT)) rollback(source, Operation.CREATE_BOT, P1, null, create("rollback-" + injection.name()), injection);
        rollback(source, Operation.CREATE_BOT_VERSION, P1, first.bot.id, append("rollback-version", 2), TransactionObserver.Stage.VERSION_WRITTEN);
        rollback(source, Operation.CREATE_GROUP, P1, null, group("rollback-group", first), TransactionObserver.Stage.MEMBER_WRITTEN);
        rollback(source, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("rollback-members", 2, members(), g.bots), TransactionObserver.Stage.MEMBER_WRITTEN);
        rollback(source, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("rollback-before-commit", 2, members(), g.bots), TransactionObserver.Stage.BEFORE_COMMIT);
        stage = "outcome-unknown";
        CreateBotVersionRequest lost = append("lost-response", 2);
        BotApplication lossy = new BotApplication(source, policy(true), reached -> { if (reached == TransactionObserver.Stage.AFTER_COMMIT) throw new IllegalStateException("TEST_LOST_RESPONSE"); });
        error(call(lossy, Operation.CREATE_BOT_VERSION, P1, first.bot.id, lost), Operation.CREATE_BOT_VERSION, ErrorCode.OUTCOME_UNKNOWN, 409);
        ApplicationResponse reconciled = call(new BotApplication(source, policy(true)), Operation.CREATE_BOT_VERSION, P1, first.bot.id, lost); BotResult third = bot(reconciled, Operation.CREATE_BOT_VERSION); check(third.bot.version == 3);
        replay(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, lost, reconciled);
        replay(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, v, appended);

        stage = "corrupt-receipt";
        for (String field : Arrays.asList("spaceId", "id", "name", "createdAt")) corruptReceipt(source, app, Operation.CREATE_BOT, "create", null, c, created, n -> ((ObjectNode)n.get("bot")).put(field, field.equals("createdAt") ? "2020-01-01T00:00:00Z" : "different"));
        corruptReceipt(source, app, Operation.CREATE_BOT, "create", null, c, created, n -> ((ObjectNode)n.get("bot")).put("version", 2));
        corruptReceipt(source, app, Operation.CREATE_BOT_VERSION, "append", first.bot.id, v, appended, n -> ((ObjectNode)n.get("botVersion")).put("id", other.botVersion.id));
        corruptReceipt(source, app, Operation.CREATE_GROUP, "group", null, g, createdGroup, n -> ((ObjectNode)n.get("group")).put("createdAt", "2020-01-01T00:00:00Z"));
        edit(source, "UPDATE command_receipts SET body_bytes=? WHERE space_id='A' AND principal_id='p1' AND command_id='create'", "{\"bot\":{},\"bot\":{}}".getBytes(StandardCharsets.UTF_8)); denied(source, app, Operation.CREATE_BOT, P1, null, c, ErrorCode.DEPENDENCY_UNAVAILABLE, 503); corruptChecks++;
        edit(source, "UPDATE command_receipts SET body_bytes=? WHERE space_id='A' AND principal_id='p1' AND command_id='create'", created.body());

        stage = "corrupt-storage";
        for (String pointer : Arrays.asList("missing", first.botVersion.id, other.botVersion.id, foreign.botVersion.id)) {
            edit(source, "UPDATE bots SET current_bot_version_id=? WHERE space_id='A' AND id=?", pointer, first.bot.id);
            denied(source, app, Operation.GET_BOT, P1, first.bot.id, null, ErrorCode.DEPENDENCY_UNAVAILABLE, 503);
            edit(source, "UPDATE bots SET current_bot_version_id=? WHERE space_id='A' AND id=?", third.botVersion.id, first.bot.id);
        }
        edit(source, "UPDATE bot_versions SET config_bytes=? WHERE space_id='A' AND id=?", "{\"description\":\"one\",\"description\":\"two\"}".getBytes(StandardCharsets.UTF_8), third.botVersion.id);
        denied(source, app, Operation.GET_BOT, P1, first.bot.id, null, ErrorCode.DEPENDENCY_UNAVAILABLE, 503);
        edit(source, "UPDATE bot_versions SET config_bytes=? WHERE space_id='A' AND id=?", bytes(third.botVersion.config), third.botVersion.id);
        edit(source, "UPDATE bots SET version=? WHERE space_id='A' AND id=?", 9007199254740991L, first.bot.id);
        edit(source, "UPDATE bot_versions SET number=? WHERE space_id='A' AND id=?", 9007199254740991L, third.botVersion.id);
        denied(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, append("upper-bound", 9007199254740991L), ErrorCode.VERSION_CONFLICT, 409);
        edit(source, "UPDATE bot_versions SET number=? WHERE space_id='A' AND id=?", 9007199254740992L, third.botVersion.id);
        denied(source, app, Operation.GET_BOT, P1, first.bot.id, null, ErrorCode.DEPENDENCY_UNAVAILABLE, 503);
        edit(source, "UPDATE bot_versions SET number=? WHERE space_id='A' AND id=?", 3L, third.botVersion.id); edit(source, "UPDATE bots SET version=? WHERE space_id='A' AND id=?", 3L, first.bot.id);

        stage = "disabled-and-revoked";
        edit(source, "UPDATE bots SET status='disabled' WHERE space_id='A' AND id=?", first.bot.id);
        bot(call(app, Operation.GET_BOT, P1, first.bot.id, null), Operation.GET_BOT); replay(source, app, Operation.CREATE_BOT, P1, null, c, created);
        denied(source, app, Operation.CREATE_BOT_VERSION, P1, first.bot.id, append("disabled-version", 3), ErrorCode.FORBIDDEN, 403);
        denied(source, app, Operation.CREATE_GROUP, P1, null, group("disabled-binding", first), ErrorCode.FORBIDDEN, 403);
        group(call(app, Operation.UPDATE_GROUP_MEMBERS, P4, originalGroup.group.id, update("unchanged-disabled", 2, members(), g.bots)), Operation.UPDATE_GROUP_MEMBERS);
        edit(source, "UPDATE bots SET status='active' WHERE space_id='A' AND id=?", first.bot.id);
        edit(source, "UPDATE bot_maintainers SET principal_id='p9' WHERE space_id='A' AND bot_id=? AND principal_id='p1'", first.bot.id);
        denied(source, app, Operation.CREATE_BOT, P1, null, conflict, ErrorCode.FORBIDDEN, 403);
        edit(source, "UPDATE bot_maintainers SET principal_id='p1' WHERE space_id='A' AND bot_id=? AND principal_id='p9'", first.bot.id);
        UpdateGroupMembersRequest removeSelf = update("remove-self", 3, Arrays.asList(member("p4", GroupMemberRole.ADMIN), member("p3", GroupMemberRole.PARTICIPANT)), g.bots);
        group(call(app, Operation.UPDATE_GROUP_MEMBERS, P1, originalGroup.group.id, removeSelf), Operation.UPDATE_GROUP_MEMBERS);
        denied(source, app, Operation.UPDATE_GROUP_MEMBERS, P1, originalGroup.group.id, removeSelf, ErrorCode.FORBIDDEN, 403); denied(source, app, Operation.CREATE_GROUP, P1, null, g, ErrorCode.FORBIDDEN, 403);
        stage = "expiry";
        edit(source, "UPDATE command_receipts SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 8 DAY),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE space_id='A' AND principal_id='p1' AND command_id='create'");
        denied(source, app, Operation.CREATE_BOT, P1, null, conflict, ErrorCode.COMMAND_EXPIRED, 409);

        stage = "maximum-unicode";
        CreateBotRequest large = create("large"); large.config.description = large.config.instructions = large.config.persona = String.join("", Collections.nCopies(16384, "🚀"));
        BotResult max = bot(call(app, Operation.CREATE_BOT, P1, null, large), Operation.CREATE_BOT); check(max.botVersion.config.persona.equals(large.config.persona));
        BotResult again = bot(call(new BotApplication(source, policy(true)), Operation.GET_BOT, P1, max.bot.id, null), Operation.GET_BOT); check(Arrays.equals(bytes(max.botVersion.config), bytes(again.botVersion.config)));
    }
    private static BotResult storedCreation(HikariDataSource source, String space, String command) throws Exception {
        try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement("SELECT body_bytes FROM command_receipts WHERE space_id=? AND principal_id='p1' AND command_id=?")) {
            p.setString(1, space); p.setString(2, command); p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) { check(r.next()); BotResult result = BOUNDARY.readResponse("createBot", 201, r.getBytes(1), BotResult.class); check(!r.next()); return result; }
        }
    }
    private static void reopen(HikariDataSource source) throws Exception {
        stage = "reopen"; BotApplication app = new BotApplication(source, policy(true)); BotResult created = storedCreation(source, "A", "create");
        BotResult read = bot(call(app, Operation.GET_BOT, P1, created.bot.id, null), Operation.GET_BOT); check(read.bot.version == 3); check(read.bot.name.equals(create("create").name)); check(read.bot.maintainerIds.equals(Arrays.asList("p2", "p1")));
        try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement("SELECT target_id FROM command_receipts WHERE space_id='A' AND principal_id='p1' AND command_id='group'")) {
            p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) { check(r.next()); GroupResult g = group(call(app, Operation.GET_GROUP, P4, r.getString(1), null), Operation.GET_GROUP); check(g.group.version == 4); check(g.group.bots.get(0).botVersionId.equals(created.botVersion.id)); check(g.group.members.get(0).principalId.equals("p4")); check(g.group.name.equals("群🚀\u0000\ud800\udc00")); }
        }
        BotResult large = storedCreation(source, "A", "large"); BotResult max = bot(call(app, Operation.GET_BOT, P1, large.bot.id, null), Operation.GET_BOT); check(max.botVersion.config.description.codePointCount(0, max.botVersion.config.description.length()) == 16384);
    }
    private static void seedRace(HikariDataSource source) { stage = "race-seed"; bot(call(new BotApplication(source, policy(true)), Operation.CREATE_BOT, new TrustedContext("race", "p1"), null, create("seed")), Operation.CREATE_BOT); }
    private static ObjectNode race(HikariDataSource source, String mode, BufferedReader control) throws Exception {
        stage = "race"; BotResult seed = storedCreation(source, "race", "seed");
        TransactionObserver observer = reached -> {
            try {
                if (reached == TransactionObserver.Stage.BEFORE_SCOPE) {
                    System.out.println("{\"stage\":\"armed\"}"); System.out.flush(); if (!"go".equals(control.readLine())) throw new IllegalStateException("TEST_CONTROL"); System.out.println("{\"stage\":\"started\"}"); System.out.flush();
                }
                if (reached == TransactionObserver.Stage.SCOPE_LOCKED) {
                    if (!mode.equals("race-same")) { System.out.println("{\"stage\":\"scoped\"}"); System.out.flush(); if (!"commit-go".equals(control.readLine())) throw new IllegalStateException("TEST_CONTROL"); }
                    else Thread.sleep(500);
                }
            } catch (Exception failure) { throw new IllegalStateException("TEST_CONTROL"); }
        };
        boolean same = mode.equals("race-same"); String principal = mode.equals("race-cas-b") ? "p2" : "p1";
        ApplicationResponse result = call(new BotApplication(source, policy(true), observer), Operation.CREATE_BOT_VERSION, new TrustedContext("race", principal), seed.bot.id, append(same ? "same" : mode, same ? 1 : 2));
        if (result.status == 409) error(result, Operation.CREATE_BOT_VERSION, ErrorCode.VERSION_CONFLICT, 409); else bot(result, Operation.CREATE_BOT_VERSION);
        ObjectNode proof = JSON.createObjectNode().put("httpStatus", result.status).put("bodyHash", Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(result.body())));
        return proof;
    }
    private static void verifyRace(HikariDataSource source) throws Exception {
        stage = "race-verify"; BotResult seed = storedCreation(source, "race", "seed"); BotResult current = bot(call(new BotApplication(source, policy(true)), Operation.GET_BOT, new TrustedContext("race", "p1"), seed.bot.id, null), Operation.GET_BOT); check(current.bot.version == 3 && current.botVersion.number == 3);
        for (String table : Arrays.asList("bots", "bot_versions", "command_receipts", "mutation_outbox")) try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement("SELECT COUNT(*) FROM " + table + " WHERE space_id='race'")) {
            p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) { check(r.next()); check(r.getInt(1) == (table.equals("bots") ? 1 : 3)); }
        }
        try (Connection c = source.getConnection(); PreparedStatement p = c.prepareStatement("SELECT COUNT(*) FROM command_receipts WHERE space_id='race' AND command_id='same' AND principal_id='p1'")) { p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) { check(r.next()); check(r.getInt(1) == 1); } }
    }
    public static void main(String[] args) {
        int exit = 1;
        try {
            if (args.length != 1 || !Arrays.asList("suite", "reopen", "race-seed", "race-same", "race-cas-a", "race-cas-b", "race-verify", "hold").contains(args[0])) throw new AssertionError("SELECTION");
            BufferedReader control = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)); String line = control.readLine(); check(line != null && line.length() <= 4096);
            LocalDatabaseConfig config = LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(line.getBytes(StandardCharsets.UTF_8)));
            try (HikariDataSource source = config.openPool()) {
                DatabaseReadiness.requireReady(source); ObjectNode result = JSON.createObjectNode();
                switch (args[0]) {
                    case "suite": suite(source); result.set("responses", responses); break;
                    case "reopen": reopen(source); break;
                    case "race-seed": seedRace(source); break;
                    case "race-verify": verifyRace(source); break;
                    case "hold": stage = "hold"; System.out.println("{\"stage\":\"armed\"}"); System.out.flush(); check("go".equals(control.readLine())); break;
                    default: result = race(source, args[0], control);
                }
                result.put("status", "verified").put("assertions", assertions).put("denials", denials).put("replays", replayChecks).put("rollbacks", rollbackChecks).put("corruptReceipts", corruptChecks);
                System.out.println(result); exit = 0;
            }
        } catch (Throwable failure) { System.out.println(JSON.createObjectNode().put("status", "failed").put("category", "C1_PROBE_FAILURE").put("stage", stage)); }
        System.exit(exit);
    }
}
