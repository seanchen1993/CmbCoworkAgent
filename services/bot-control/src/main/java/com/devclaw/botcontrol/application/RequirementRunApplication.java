package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.application.RuntimeNodeApplication.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.io.*;
import java.security.MessageDigest;
import java.sql.*;
import java.time.Instant;
import javax.sql.DataSource;

/** Internal control only. A claim is not a RunSpec, tool permission or proof of
 * execution. Future authenticated node transport and start must revalidate it.
 * Single attempt; expired/lost execution is NEVER retried or migrated here. */
public final class RequirementRunApplication {
    public static final long LEASE_MILLIS = 30000, MAX_DEADLINE_MILLIS = 3600000, RECEIPT_MILLIS = 604800000;
    private final DataSource source; private final IdentityPolicy identity; private final TransactionObserver observer;
    private final RuntimeNodeApplication nodes; private final ContractBoundary boundary = new ContractBoundary();
    public RequirementRunApplication(DataSource source, IdentityPolicy identity, RuntimeAccessPolicy access, TransactionObserver observer) {
        nodes = new RuntimeNodeApplication(source, identity, access, observer); this.source = source; this.identity = identity; this.observer = observer;
    }
    private void id(String value) { boundary.validateParameter("getBot", "botId", value); }
    private void actor(TrustedContext actor) {
        if (actor == null || actor.principalId == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
        id(actor.spaceId); id(actor.principalId);
        if (!identity.activeMember(actor.spaceId, actor.principalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
    }
    private static void version(long value) { if (value < 1 || value > JdbcTaskStore.MAX) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD); }
    private interface Call<T> { T run(); }
    private <T> T safe(Call<T> call) {
        try { return call.run(); }
        catch (ApplicationFault f) { throw f; }
        catch (ContractBoundary.Failure f) { throw new ApplicationFault(f.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD); }
        catch (RuntimeException f) { throw JdbcApplicationStore.corrupt(); }
    }
    private interface Work<T> { T run(Connection c, JdbcApplicationStore db, JdbcRequirementRunStore runs) throws SQLException; }
    private <T> T transaction(String space, boolean write, Work<T> work) {
        boolean commitAttempted = false;
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED); c.setAutoCommit(false);
            try {
                T result = work.run(c, new JdbcApplicationStore(c, space, observer), new JdbcRequirementRunStore(c, space));
                if (write) observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);
                commitAttempted = true; c.commit();
                if (write) observer.reached(TransactionObserver.Stage.AFTER_COMMIT); return result;
            } catch (SQLException | RuntimeException f) {
                if (!commitAttempted) try { c.rollback(); } catch (SQLException ignored) { /* no safe result */ }
                if (commitAttempted && write) throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);
                if (f instanceof ApplicationFault) throw (ApplicationFault)f; throw JdbcApplicationStore.corrupt();
            }
        } catch (SQLException f) { throw new ApplicationFault(commitAttempted && write ? ErrorCode.OUTCOME_UNKNOWN : ErrorCode.DEPENDENCY_UNAVAILABLE); }
    }
    private static byte[] fingerprint(String task, String bot, long version, Instant deadline) {
        try {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); DataOutputStream out = new DataOutputStream(bytes);
            out.writeUTF("requirement-enqueue-v1"); out.writeUTF(task); out.writeUTF(bot); out.writeLong(version); out.writeLong(deadline.toEpochMilli()); out.flush();
            return MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());
        } catch (Exception f) { throw JdbcApplicationStore.corrupt(); }
    }
    public static final class Enqueued {
        public final String runId; public final Status status; public final long taskVersion; public final Instant createdAt;
        private Enqueued(Run run) { runId = run.id; status = run.initialStatus; taskVersion = run.taskVersion; createdAt = run.createdAt; }
    }
    private Group group(JdbcApplicationStore db, TrustedContext actor, String groupId) throws SQLException { return nodes.readGroupInTransaction(db, actor, groupId); }
    private Run run(JdbcApplicationStore db, JdbcRequirementRunStore runs, TrustedContext actor, String runId) throws SQLException {
        String groupId = runs.groupId(runId); if (groupId == null) throw new ApplicationFault(ErrorCode.NOT_FOUND);
        group(db, actor, groupId); Run run = runs.run(runId);
        if (run == null || !groupId.equals(run.groupId)) throw JdbcApplicationStore.corrupt(); return run;
    }
    public Enqueued enqueueRequirement(TrustedContext requester, String commandId, String taskId, String botId, long expectedTaskVersion, Instant deadline) {
        return safe(() -> {
            actor(requester); id(commandId); id(taskId); id(botId); version(expectedTaskVersion);
            if (deadline == null || deadline.getNano() % 1000000 != 0) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
            byte[] hash = fingerprint(taskId, botId, expectedTaskVersion, deadline);
            return transaction(requester.spaceId, true, (c, db, runs) -> {
                // Internal namespace only; no public command receipt is created.
                db.lockScope(requester.principalId);
                String oldGroup = runs.commandGroupId(requester.principalId, commandId);
                if (oldGroup != null) {
                    group(db, requester, oldGroup);
                    Run old = runs.command(requester.principalId, commandId);
                    if (old == null || !oldGroup.equals(old.groupId)) throw JdbcApplicationStore.corrupt();
                    Instant now = db.now().toInstant();
                    if (!now.isBefore(old.createdAt.plusMillis(RECEIPT_MILLIS))) throw new ApplicationFault(ErrorCode.COMMAND_EXPIRED);
                    if (!old.sameCommand(hash)) throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                    return new Enqueued(old); // Current read authorization BEFORE replay; no new CAS/start.
                }
                RequirementDispatch d = nodes.resolveInTransaction(c, db, new JdbcRuntimeNodeStore(c, requester.spaceId), requester, taskId, botId);
                if (expectedTaskVersion != d.taskVersion) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, d.taskVersion);
                if (!deadline.isAfter(d.observedAt) || deadline.isAfter(d.observedAt.plusMillis(MAX_DEADLINE_MILLIS))) throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
                Group g = group(db, requester, d.groupId);
                if (runs.activeCount(g.id) >= g.limits.maxRuns) throw new ApplicationFault(ErrorCode.RATE_LIMITED);
                return new Enqueued(runs.enqueue(commandId, hash, d, deadline, d.status == DispatchStatus.READY ? Status.QUEUED : Status.WAITING_NODE));
            });
        });
    }
    public Run getRequirementRun(TrustedContext reader, String runId) {
        return safe(() -> { actor(reader); id(runId); return transaction(reader.spaceId, false, (c, db, runs) -> run(db, runs, reader, runId)); });
    }
    public Run claimRequirementRun(TrustedNodeContext node, String runId) {
        return safe(() -> {
            if (node == null) throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
            TrustedContext owner = new TrustedContext(node.spaceId, node.ownerPrincipalId); actor(owner); id(node.nodeId); id(runId);
            return transaction(node.spaceId, true, (c, db, runs) -> {
                Run old = run(db, runs, owner, runId);
                if (!node.nodeId.equals(old.nodeId) || !owner.principalId.equals(old.ownerPrincipalId)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                if (old.status == Status.CANCELLED || old.status == Status.CANCEL_REQUESTED) throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                if (old.status == Status.RUNNING || old.status == Status.SUCCEEDED || old.status == Status.FAILED) throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                RequirementDispatch d = nodes.resolveInTransaction(c, db, new JdbcRuntimeNodeStore(c, node.spaceId), new TrustedContext(old.spaceId, old.requesterPrincipalId), old.taskId, old.botId);
                if (!old.sameSnapshot(d)) throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
                if (old.status == Status.OUTCOME_UNKNOWN) return old; // Never allocates a new lease/attempt.
                if (old.status == Status.STARTING) {
                    if (!d.observedAt.isBefore(old.leaseExpiresAt)) return runs.expiredClaim(old, d.observedAt);
                    if (d.status != DispatchStatus.READY) throw new ApplicationFault(ErrorCode.NODE_OFFLINE);
                    return old; // Same unextended lease; a duplicate is not a second start.
                }
                if (!d.observedAt.isBefore(old.deadline)) throw new ApplicationFault(ErrorCode.COMMAND_EXPIRED);
                if (d.status != DispatchStatus.READY) return old.status == Status.QUEUED ? runs.waitForNode(old, d.observedAt) : old;
                Instant expiry = d.observedAt.plusMillis(LEASE_MILLIS);
                if (expiry.isAfter(d.validUntil)) expiry = d.validUntil;
                if (expiry.isAfter(old.deadline)) expiry = old.deadline;
                return runs.claim(old, d.observedAt, expiry);
            });
        });
    }
    public static final class Input {
        public final Bot bot; public final BotVersion botVersion; public final Group group; public final Task task;
        public final java.util.List<TaskMessageResult> messages;
        private Input(Connection c, JdbcApplicationStore db, Run run) throws SQLException {
            bot=db.bot(run.botId);botVersion=db.version(run.botVersionId);group=db.group(run.groupId);task=new JdbcTaskStore(c,run.spaceId).task(run.taskId);
            if(bot==null||botVersion==null||group==null||task==null)throw JdbcApplicationStore.corrupt();
            if(task.version!=run.taskVersion)throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
            messages=new JdbcTaskStore(c,run.spaceId).requirementMessages(task,run.botId);
        }
    }
    public static final class Started {
        public final Run run; public final Input input;
        private Started(Run run,Input input){this.run=run;this.input=input;}
    }
    private TrustedContext nodeOwner(TrustedNodeContext node,String runId,String attemptId,String leaseId,long fence) {
        if(node==null)throw new ApplicationFault(ErrorCode.UNAUTHENTICATED);
        TrustedContext owner=new TrustedContext(node.spaceId,node.ownerPrincipalId);actor(owner);id(node.nodeId);id(runId);id(attemptId);id(leaseId);
        if(fence!=1)throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);return owner;
    }
    private void ticket(TrustedNodeContext node,Run old,String attempt,String lease,long fence){
        if(!old.nodeId.equals(node.nodeId)||!old.ownerPrincipalId.equals(node.ownerPrincipalId))throw new ApplicationFault(ErrorCode.FORBIDDEN);
        if(!attempt.equals(old.attemptId)||!lease.equals(old.leaseId)||old.fence==null||old.fence!=fence)throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
    }
    private RequirementDispatch dispatch(Connection c,JdbcApplicationStore db,Run old)throws SQLException{
        RequirementDispatch d=nodes.resolveInTransaction(c,db,new JdbcRuntimeNodeStore(c,old.spaceId),new TrustedContext(old.spaceId,old.requesterPrincipalId),old.taskId,old.botId);
        if(!old.sameSnapshot(d))throw new ApplicationFault(ErrorCode.INPUT_CHANGED);
        if(d.status!=DispatchStatus.READY)throw new ApplicationFault(ErrorCode.NODE_OFFLINE);return d;
    }
    public Started startRequirementRun(TrustedNodeContext node,String runId,String attemptId,String leaseId,long fence){
        return safe(()->{TrustedContext owner=nodeOwner(node,runId,attemptId,leaseId,fence);
            Started result=transaction(node.spaceId,true,(c,db,runs)->{
                Run old=run(db,runs,owner,runId);ticket(node,old,attemptId,leaseId,fence);
                if(old.status==Status.OUTCOME_UNKNOWN) return new Started(old,null);
                if(old.status!=Status.STARTING&&old.status!=Status.RUNNING)throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                // Persist unknown before raising outside the transaction, including after ACL withdrawal.
                Instant now=db.now().toInstant();if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline))return new Started(runs.expiredClaim(old,now),null);
                RequirementDispatch d=dispatch(c,db,old);Input input=new Input(c,db,old);now=db.now().toInstant();
                if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline))return new Started(runs.expiredClaim(old,now),null);
                if(!now.isBefore(d.validUntil))throw new ApplicationFault(ErrorCode.NODE_OFFLINE);
                Run running=old.status==Status.STARTING?runs.start(old,now):old;return new Started(running,input);
            });if(result.run.status==Status.OUTCOME_UNKNOWN)throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);return result;
        });
    }
    public Run renewRequirementRun(TrustedNodeContext node,String runId,String attemptId,String leaseId,long fence){
        return safe(()->{TrustedContext owner=nodeOwner(node,runId,attemptId,leaseId,fence);
            Run result=transaction(node.spaceId,true,(c,db,runs)->{
                Run old=run(db,runs,owner,runId);ticket(node,old,attemptId,leaseId,fence);
                if(old.status==Status.OUTCOME_UNKNOWN)return old;
                if(old.status!=Status.RUNNING)throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                Instant now=db.now().toInstant();if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline))return runs.expiredClaim(old,now);
                RequirementDispatch d=dispatch(c,db,old);now=db.now().toInstant();
                if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline))return runs.expiredClaim(old,now);
                if(!now.isBefore(d.validUntil))throw new ApplicationFault(ErrorCode.NODE_OFFLINE);
                Instant expiry=now.plusMillis(LEASE_MILLIS);
                if(expiry.isAfter(d.validUntil))expiry=d.validUntil;if(expiry.isAfter(old.deadline))expiry=old.deadline;
                return runs.renew(old,now,expiry);
            });if(result.status==Status.OUTCOME_UNKNOWN)throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);return result;
        });
    }
    private static void resultText(String outcome,String text){
        if(!"succeeded".equals(outcome)&&!"failed".equals(outcome)||text==null||text.trim().isEmpty()||text.codePointCount(0,text.length())>16384)throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        for(int i=0;i<text.length();i++){char ch=text.charAt(i);if(Character.isHighSurrogate(ch)){if(++i>=text.length()||!Character.isLowSurrogate(text.charAt(i)))throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);}else if(Character.isLowSurrogate(ch)||ch==0)throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);}
        if("failed".equals(outcome)&&!java.util.Arrays.asList("EXECUTION_FAILED","CANCELLED","LEASE_LOST","EMPTY_OUTPUT","TOOL_CALL_REJECTED").contains(text))throw new ApplicationFault(ErrorCode.INVALID_PAYLOAD);
    }
    private static void storedResult(Run run,Result result){
        if(result==null){if(run.status==Status.SUCCEEDED||run.status==Status.FAILED)throw JdbcApplicationStore.corrupt();return;}
        if(!run.id.equals(result.runId)||run.attemptId==null||!run.attemptId.equals(result.attemptId)||!run.status.name().equalsIgnoreCase(result.outcome)||
            !run.updatedAt.equals(result.settledAt)||result.settledAt.isBefore(run.createdAt)||!result.settledAt.isBefore(run.leaseExpiresAt)||!result.settledAt.isBefore(run.deadline))throw JdbcApplicationStore.corrupt();
        try{resultText(result.outcome,result.text);}catch(ApplicationFault failure){throw JdbcApplicationStore.corrupt();}
    }
    public Result settleRequirementRun(TrustedNodeContext node,String runId,String attemptId,String leaseId,long fence,String outcome,String text){
        return safe(()->{TrustedContext owner=nodeOwner(node,runId,attemptId,leaseId,fence);resultText(outcome,text);
            Result result=transaction(node.spaceId,true,(c,db,runs)->{
                Run old=run(db,runs,owner,runId);ticket(node,old,attemptId,leaseId,fence);Result previous=runs.result(runId);storedResult(old,previous);
                if(previous!=null){if(!previous.attemptId.equals(attemptId)||!previous.outcome.equals(outcome)||!previous.text.equals(text))throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                    return previous;}
                if(old.status==Status.OUTCOME_UNKNOWN) return null;
                if(old.status!=Status.RUNNING)throw new ApplicationFault(ErrorCode.COMMAND_CONFLICT);
                Instant now=db.now().toInstant();if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline)){runs.expiredClaim(old,now);return null;}
                RequirementDispatch d=dispatch(c,db,old);now=db.now().toInstant();
                if(!now.isBefore(old.leaseExpiresAt)||!now.isBefore(old.deadline)){runs.expiredClaim(old,now);return null;}
                if(!now.isBefore(d.validUntil))throw new ApplicationFault(ErrorCode.NODE_OFFLINE);
                return runs.settle(old,now,outcome,text);
            });if(result==null)throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN);return result;
        });
    }
    public Result getRequirementResult(TrustedContext reader,String runId){
        return safe(()->{actor(reader);id(runId);return transaction(reader.spaceId,false,(c,db,runs)->{
            Run old=run(db,runs,reader,runId);Result result=runs.result(runId);
            storedResult(old,result);return result;
        });});
    }
    public Run cancelPendingRequirementRun(TrustedContext actor, String runId, long expectedRunVersion) {
        return safe(() -> {
            actor(actor); id(runId); version(expectedRunVersion);
            return transaction(actor.spaceId, true, (c, db, runs) -> {
                Run old = run(db, runs, actor, runId);
                Group g = group(db, actor, old.groupId);
                if (!old.requesterPrincipalId.equals(actor.principalId) && !ReceiptAccess.member(actor, g, true)) throw new ApplicationFault(ErrorCode.FORBIDDEN);
                if (old.version != expectedRunVersion) throw new ApplicationFault(ErrorCode.VERSION_CONFLICT, old.version);
                if (old.status == Status.CANCELLED) return old;
                if (old.status != Status.QUEUED && old.status != Status.WAITING_NODE) throw new ApplicationFault(ErrorCode.OUTCOME_UNKNOWN); // Already claimed: cannot prove stopped.
                return runs.cancelPending(old, db.now().toInstant());
            });
        });
    }
}
