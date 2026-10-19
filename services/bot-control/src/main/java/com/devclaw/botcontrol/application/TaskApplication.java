package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.*;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Text collaboration only. No artifact fetching, execution or stage transition. */
public final class TaskApplication {
    private final DataSource source; private final IdentityPolicy policy; private final TransactionObserver observer;
    private final ContractBoundary boundary = new ContractBoundary();
    public TaskApplication(DataSource source, IdentityPolicy policy, TransactionObserver observer) {
        if (source == null || policy == null || observer == null) throw new IllegalArgumentException("APPLICATION_CONSTRUCTION");
        this.source = source; this.policy = policy; this.observer = observer;
    }
    public ApplicationResponse execute(Operation op, TrustedContext actor, String id, String after, Long limit, byte[] bytes) {
        if (op == null || !op.task()) throw new IllegalArgumentException("APPLICATION_SELECTION");
        try {
            if (bytes != null && bytes.length > 1048576) throw new ApplicationFault(op.write() ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.INVALID_PAYLOAD);
            if (actor == null || actor.principalId == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
            boundary.validateParameter(op.wire, "X-DevClaw-Space", actor.spaceId);
            boundary.validateParameter("getBot", "botId", actor.principalId);
            if (op == Operation.CREATE_TASK || op == Operation.GET_EVENTS) { if (id != null) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); }
            else boundary.validateParameter(op.wire, "taskId", id);
            if (op != Operation.GET_EVENTS && (after != null || limit != null)) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
            if (after != null) boundary.validateParameter("getEvents", "after", after);
            if (limit != null) boundary.validateIntegerParameter("getEvents", "limit", limit);
            Object input;
            if (op == Operation.CREATE_TASK) input = boundary.readRequest(op.wire, bytes, CreateTaskRequest.class);
            else if (op == Operation.CREATE_TASK_MESSAGE) input = boundary.readRequest(op.wire, bytes, CreateTaskMessageRequest.class);
            else { if (bytes != null && bytes.length != 0) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); input = null; }
            if (!policy.activeMember(actor.spaceId, actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
            return transaction(op, actor, id, after, limit == null ? 200 : limit.intValue(), input);
        } catch (ApplicationFault failure) { return error(op, failure); }
        catch (ContractBoundary.Failure failure) { return error(op, new ApplicationFault(failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD)); }
        catch (RuntimeException failure) { return error(op, new ApplicationFault(ErrorCode.DEPENDENCY_UNAVAILABLE)); }
    }
    private static String command(Object input) { return input instanceof CreateTaskRequest ? ((CreateTaskRequest)input).commandId : ((CreateTaskMessageRequest)input).commandId; }
    private static String newId() { return UUID.randomUUID().toString(); }
    private static void authorize(TrustedContext actor, Group group) {
        if (!ReceiptAccess.member(actor, group, false)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private Group group(JdbcApplicationStore db, String id, boolean stored) throws SQLException {
        Group group = db.group(id); if (group == null) throw stored ? JdbcApplicationStore.corrupt() : new ApplicationFault(ErrorCode.NOT_FOUND); return group;
    }
    private Task task(JdbcTaskStore db, String id, boolean stored) throws SQLException {
        Task task = db.task(id); if (task == null) throw stored ? JdbcApplicationStore.corrupt() : new ApplicationFault(ErrorCode.NOT_FOUND); return task;
    }
    private ApplicationResponse transaction(Operation op, TrustedContext actor, String id, String after, int limit, Object input) {
        boolean commitAttempted = false;
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED); c.setAutoCommit(false);
            try {
                JdbcApplicationStore db = new JdbcApplicationStore(c, actor.spaceId, observer); JdbcTaskStore tasks = new JdbcTaskStore(c, actor.spaceId);
                if (op.write()) { observer.reached(TransactionObserver.Stage.BEFORE_SCOPE); db.lockScope(actor.principalId); observer.reached(TransactionObserver.Stage.SCOPE_LOCKED); }
                long head = tasks.lockHead(); Timestamp now = db.now();
                Task current = null; Group group = null;
                if (op == Operation.CREATE_TASK) { group = group(db, ((CreateTaskRequest)input).groupId, false); authorize(actor, group); }
                else if (op != Operation.GET_EVENTS) {
                    String groupId = tasks.groupId(id); if (groupId == null) throw new ApplicationFault(ErrorCode.NOT_FOUND);
                    group = group(db, groupId, true); authorize(actor, group); current = task(tasks, id, true);
                }
                JdbcApplicationStore.Receipt receipt = op.write() ? db.receipt(actor.principalId, command(input)) : null;
                if (receipt != null) {
                    ReceiptAccess.authorize(db, tasks, actor, receipt); ReceiptAccess.metadata(receipt, boundary);
                    if (!now.before(receipt.expires)) throw new ApplicationFault(ErrorCode.COMMAND_EXPIRED);
                    if (!op.wire.equals(receipt.operation) || !MessageDigest.isEqual(receipt.fingerprint, CanonicalCommand.fingerprint(actor, op, id, input))) throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                    verifyReceipt(op, actor, id, tasks, receipt); c.commit(); return new ApplicationResponse(receipt.status, receipt.body);
                }
                Object result; String receiptTarget = null;
                switch (op) {
                    case CREATE_TASK: {
                        CreateTaskRequest r = (CreateTaskRequest)input;
                        if (!r.inputArtifactVersions.isEmpty()) throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
                        current = new Task(); current.id = newId(); current.spaceId = actor.spaceId; current.groupId = group.id; current.version = 1L;
                        current.taskNumber = tasks.nextNumber(); current.title = r.title; current.goal = r.goal; current.status = TaskStatus.ACTIVE;
                        current.createdAt = current.updatedAt = JdbcApplicationStore.text(now); current.inputArtifactVersions = Collections.emptyList(); current.stages = new ArrayList<Stage>();
                        for (StageKind kind : StageKind.values()) {
                            Stage stage = new Stage(); stage.id = newId(); stage.kind = kind; stage.status = current.stages.isEmpty() ? StageStatus.ACTIVE : StageStatus.PENDING;
                            stage.inputArtifactVersions = stage.outputArtifactVersions = Collections.emptyList(); current.stages.add(stage);
                        }
                        current.currentStageId = current.stages.get(0).id; tasks.create(current); observer.reached(TransactionObserver.Stage.VERSION_WRITTEN);
                        TaskResult r2 = new TaskResult(); r2.task = current; result = r2; receiptTarget = current.id; break;
                    }
                    case GET_TASK: {
                        TaskSnapshotResult snapshot = new TaskSnapshotResult(); snapshot.task = current; snapshot.snapshotCursor = tasks.cursor(head, now); result = snapshot; break;
                    }
                    case CREATE_TASK_MESSAGE: {
                        CreateTaskMessageRequest r = (CreateTaskMessageRequest)input;
                        if (!current.version.equals(r.expectedVersion)) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, current.version);
                        if (!r.artifactVersions.isEmpty()) throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
                        if (r.targetBotId != null) target(db, group, r.targetBotId);
                        if (current.version >= JdbcTaskStore.MAX) throw JdbcApplicationStore.corrupt(); long previous = current.version;
                        current.version++; current.updatedAt = JdbcApplicationStore.text(now);
                        TaskMessageResult message = new TaskMessageResult(); message.taskVersion = current.version; message.message = new TaskMessage();
                        TaskMessage m = message.message; m.id = newId(); m.spaceId = actor.spaceId; m.taskId = current.id; m.authorPrincipalId = actor.principalId;
                        m.text = r.text; m.artifactVersions = Collections.emptyList(); m.createdAt = JdbcApplicationStore.text(now);
                        if(!ExpertConversationApplication.message(c,current,message,r.targetBotId))TextDeliveryApplication.message(c,current,message); tasks.advance(current, previous); observer.reached(TransactionObserver.Stage.VERSION_WRITTEN); tasks.message(message, r.targetBotId);
                        observer.reached(TransactionObserver.Stage.MEMBER_WRITTEN); result = message; receiptTarget = m.id; break;
                    }
                    case GET_EVENTS: {
                        // Keep both branches boxed: a missing cursor is 410,
                        // not a null-unboxing failure disguised as dependency 503.
                        Long cursor = after == null ? Long.valueOf(head) : tasks.cursor(after, now, head);
                        if (cursor == null) throw new ApplicationFault(ErrorCode.CURSOR_EXPIRED);
                        List<JdbcTaskStore.EventRow> rows = tasks.events(cursor, head, limit);
                        TreeMap<String, Group> groups = new TreeMap<String, Group>();
                        for (JdbcTaskStore.EventRow row : rows) groups.put(row.group, null);
                        for (String groupId : groups.keySet()) groups.put(groupId, group(db, groupId, true));
                        EventsResult events = new EventsResult(); events.events = new ArrayList<Event>(); long scanned = cursor;
                        for (JdbcTaskStore.EventRow row : rows) {
                            scanned = row.event.seq;
                            if (ReceiptAccess.member(actor, groups.get(row.group), false)) events.events.add(row.event);
                        }
                        events.nextCursor = tasks.cursor(scanned, now); events.hasMore = scanned < head; result = events; break;
                    }
                    default: throw new AssertionError();
                }
                byte[] body = boundary.writeResponse(op.wire, op.success, result);
                if (op.write()) {
                    observer.reached(TransactionObserver.Stage.BEFORE_RECEIPT);
                    db.record(actor.principalId, command(input), op.wire, op.receiptType(), receiptTarget, CanonicalCommand.fingerprint(actor, op, id, input), op.success, body, "task", current.id, current.version, now);
                    tasks.event(current, actor.principalId, command(input), head, now);
                    observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);
                }
                commitAttempted = true; c.commit(); if (op.write()) observer.reached(TransactionObserver.Stage.AFTER_COMMIT);
                return new ApplicationResponse(op.success, body);
            } catch (SQLException | RuntimeException failure) {
                if (!commitAttempted) try { c.rollback(); } catch (SQLException ignored) { /* fail closed */ }
                if (commitAttempted && op.write()) throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);
                if (failure instanceof ApplicationFault) throw (ApplicationFault)failure;
                throw JdbcApplicationStore.corrupt();
            }
        } catch (SQLException failure) { throw new ApplicationFault(commitAttempted && op.write() ? ErrorCode.OUTCOME_UNKNOWN : ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private void target(JdbcApplicationStore db, Group group, String target) throws SQLException {
        GroupBot binding = null; for (GroupBot b : group.bots) if (target.equals(b.botId)) binding = b;
        if (binding == null) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        Bot bot = db.bot(binding.botId); BotVersion version = db.version(binding.botVersionId);
        if (bot == null || version == null || bot.status != BotStatus.ACTIVE || !bot.id.equals(version.botId) || !group.spaceId.equals(version.spaceId)) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
    }
    private static boolean sameInitialStages(Task current,Task historical) {
        if(current.stages.size()!=historical.stages.size())return false;
        for(int i=0;i<current.stages.size();i++){
            Stage a=current.stages.get(i),b=historical.stages.get(i);
            if(!a.id.equals(b.id)||a.kind!=b.kind||b.status!=(i==0?StageStatus.ACTIVE:StageStatus.PENDING)||!b.inputArtifactVersions.isEmpty()||!b.outputArtifactVersions.isEmpty())return false;
        }return true;
    }
    private void verifyReceipt(Operation op, TrustedContext actor, String path, JdbcTaskStore tasks, JdbcApplicationStore.Receipt r) throws SQLException {
        try {
            if (op == Operation.CREATE_TASK) {
                Task historical = boundary.readResponse(op.wire, r.status, r.body, TaskResult.class).task; Task stored = task(tasks, r.target, true);
                if (!actor.spaceId.equals(historical.spaceId) || !r.target.equals(historical.id) || !stored.groupId.equals(historical.groupId) || !stored.taskNumber.equals(historical.taskNumber) || !stored.createdAt.equals(historical.createdAt) || !historical.createdAt.equals(historical.updatedAt) || !stored.title.equals(historical.title) || !stored.goal.equals(historical.goal) || historical.version != 1L || historical.status != TaskStatus.ACTIVE || !historical.inputArtifactVersions.isEmpty() || !sameInitialStages(stored,historical) || !Objects.equals(stored.currentStageId, historical.currentStageId)) throw JdbcApplicationStore.corrupt();
            } else {
                TaskMessageResult historical = boundary.readResponse(op.wire, r.status, r.body, TaskMessageResult.class); TaskMessageResult stored = tasks.message(r.target);
                if (!actor.spaceId.equals(historical.message.spaceId) || !actor.principalId.equals(historical.message.authorPrincipalId) || !path.equals(historical.message.taskId) || !r.target.equals(historical.message.id) || !Arrays.equals(JdbcApplicationStore.json(historical), JdbcApplicationStore.json(stored))) throw JdbcApplicationStore.corrupt();
                if (task(tasks, path, true).version < historical.taskVersion || !historical.message.artifactVersions.isEmpty()) throw JdbcApplicationStore.corrupt();
            }
        } catch (ContractBoundary.Failure failure) { throw JdbcApplicationStore.corrupt(); }
    }
    private ApplicationResponse error(Operation op, ApplicationFault failure) {
        ErrorCode code = failure.code; int status;
        switch (code) {
            case INVALID_PAYLOAD: status = 400; break;
            case UNAUTHENTICATED: status = 401; break;
            case FORBIDDEN: status = 403; break;
            case NOT_FOUND: status = 404; break;
            case INPUT_CHANGED: case VERSION_CONFLICT: case COMMAND_CONFLICT: case COMMAND_EXPIRED: case OUTCOME_UNKNOWN: status = 409; break;
            case CURSOR_EXPIRED: status = 410; break;
            case PAYLOAD_TOO_LARGE: status = 413; break;
            default: code = ErrorCode.DEPENDENCY_UNAVAILABLE; status = 503;
        }
        if ((status == 410 && op != Operation.GET_EVENTS) || (status == 404 && op == Operation.GET_EVENTS) || (status == 409 && !op.write())) { code = ErrorCode.DEPENDENCY_UNAVAILABLE; status = 503; }
        ErrorResponse response = new ErrorResponse(); response.requestId = newId(); response.error = new ErrorResponseError(); response.error.code = code; response.error.message = code.wire(); response.error.retryable = false; response.error.currentVersion = failure.currentVersion;
        return new ApplicationResponse(status, boundary.writeResponse(op.wire, status, response));
    }
}
