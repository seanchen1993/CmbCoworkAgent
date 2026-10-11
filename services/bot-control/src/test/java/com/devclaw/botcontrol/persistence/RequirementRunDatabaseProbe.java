package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.application.RequirementRunApplication.Enqueued;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.persistence.RuntimeNodeDatabaseProbe.Policy;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.security.MessageDigest;
import java.security.DigestOutputStream;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** Fixed finite actions, disposable test schemas only. Never an execution main. */
public final class RequirementRunDatabaseProbe {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private static final ContractBoundary B=new ContractBoundary();
    private static final TrustedContext OWNER=new TrustedContext("A","owner"), BUSINESS=new TrustedContext("A","business"), OTHER=new TrustedContext("A","other");
    private static final TrustedNodeContext NODE=new TrustedNodeContext("A","node","owner");
    private static final Set<Capability> CAPS=Collections.singleton(Capability.REQUIREMENTS_ANALYZE);
    private static String phase="input"; private static int denials;
    private static void check(boolean v){if(!v)throw new IllegalStateException("RUN_PROBE_ASSERTION");}
    private static void denied(ErrorCode code,Runnable work){try{work.run();throw new IllegalStateException("MISSING_DENIAL");}catch(ApplicationFault f){if(f.code!=code)throw new IllegalStateException("EXPECTED_"+code.wire()+"_ACTUAL_"+f.code.wire());check(f.getCause()==null);denials++;}}
    private static void exact(JsonNode n,String... keys){Set<String> names=new HashSet<String>();n.fieldNames().forEachRemaining(names::add);check(n.isObject()&&names.equals(new HashSet<String>(Arrays.asList(keys))));}
    private static String id(JsonNode n,String key){check(n.path(key).isTextual());return B.validateParameter("getBot","botId",n.path(key).textValue());}
    private static Instant deadline(){return Instant.ofEpochMilli(System.currentTimeMillis()+1200000);}
    private static RequirementRunApplication app(HikariDataSource s,Policy p,TransactionObserver observer){return new RequirementRunApplication(s,p,p,observer);}
    private static void sql(HikariDataSource s,String sql,Object... values)throws Exception{try(Connection c=s.getConnection();PreparedStatement p=c.prepareStatement(sql)){c.setAutoCommit(false);p.setQueryTimeout(2);for(int i=0;i<values.length;i++){Object v=values[i];if(v instanceof byte[])p.setBytes(i+1,(byte[])v);else if(v instanceof Instant)p.setTimestamp(i+1,Timestamp.from((Instant)v),Calendar.getInstance(TimeZone.getTimeZone("UTC")));else p.setObject(i+1,v);}check(p.executeUpdate()==1);c.commit();}}
    private static long count(HikariDataSource s)throws Exception{try(Connection c=s.getConnection();Statement p=c.createStatement()){p.setQueryTimeout(2);try(ResultSet r=p.executeQuery("SELECT COUNT(*) FROM requirement_run_queue")){check(r.next());return r.getLong(1);}}}
    private static long taskVersion(HikariDataSource s,String task)throws Exception{try(Connection c=s.getConnection()){c.setAutoCommit(false);long version=new JdbcTaskStore(c,"A").task(task).version;c.rollback();return version;}}
    private static String v3Facts(HikariDataSource s)throws Exception{
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(DataOutputStream out=new DataOutputStream(new DigestOutputStream(new OutputStream(){public void write(int b){}},digest));Connection c=s.getConnection()){
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);c.setAutoCommit(false);
            for(String table:DatabaseReadiness.TABLES){if(table.equals("requirement_run_queue"))continue;
                // Hash rows as sorted original bytes, including every V3 table and history1..3.
                List<String> rows=new ArrayList<String>();try(PreparedStatement p=c.prepareStatement("SELECT * FROM "+table+(table.equals("bot_schema_history")?" WHERE version IN ('1','2','3')":""))){p.setQueryTimeout(2);try(ResultSet r=p.executeQuery()){while(r.next()){ByteArrayOutputStream b=new ByteArrayOutputStream();DataOutputStream row=new DataOutputStream(b);for(int i=1;i<=r.getMetaData().getColumnCount();i++){byte[] value=r.getBytes(i);row.writeInt(value==null?-1:value.length);if(value!=null)row.write(value);}rows.add(Base64.getEncoder().encodeToString(b.toByteArray()));}}}Collections.sort(rows);out.writeUTF(table);for(String row:rows){byte[] bytes=row.getBytes("US-ASCII");out.writeInt(bytes.length);out.write(bytes);}out.writeInt(-1);
            }c.rollback();
        }StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();
    }
    private static ObjectNode seed(HikariDataSource s,Policy p)throws Exception{
        ObjectNode f=RuntimeNodeDatabaseProbe.seed(s,p);RuntimeNodeApplication nodes=new RuntimeNodeApplication(s,p,p,TransactionObserver.NONE);
        nodes.observeDesktopNode(NODE,true,CAPS);nodes.observeDesktopNode(new TrustedNodeContext("A","other-node","other"),true,CAPS);
        nodes.authorizeRequirementNode(OWNER,id(f,"group"),"node","view",0,deadline());return f;
    }
    private static void members(HikariDataSource s,Policy p,String group,boolean business)throws Exception{
        Group g;try(Connection c=s.getConnection()){c.setAutoCommit(false);g=new JdbcApplicationStore(c,"A",TransactionObserver.NONE).group(group);c.rollback();}
        UpdateGroupMembersRequest r=new UpdateGroupMembersRequest();r.commandId=UUID.randomUUID().toString();r.expectedVersion=g.version;r.bots=g.bots;r.members=new ArrayList<GroupMember>();
        for(GroupMember m:g.members)if(business||!m.principalId.equals("business"))r.members.add(m);
        if(business&&!r.members.stream().anyMatch(m->m.principalId.equals("business"))){GroupMember m=new GroupMember();m.principalId="business";m.role=GroupMemberRole.PARTICIPANT;r.members.add(m);}
        check(new BotApplication(s,p).execute(Operation.UPDATE_GROUP_MEMBERS,OTHER,group,JdbcApplicationStore.json(r)).status==200);
    }
    private static ObjectNode exercise(HikariDataSource s,Policy p,ObjectNode f)throws Exception{
        phase="seed";if(f.size()==0)f=seed(s,p);else {check(f.path("v3Facts").asText().equals(v3Facts(s)));f.remove("v3Facts");f.remove("migrations");}
        final String group=id(f,"group"),task=id(f,"task"),bot=id(f,"bot"),pin=id(f,"botVersion");
        RequirementRunApplication app=app(s,p,TransactionObserver.NONE);RuntimeNodeApplication nodes=new RuntimeNodeApplication(s,p,p,TransactionObserver.NONE);nodes.observeDesktopNode(NODE,true,CAPS);
        phase="queue-and-receipt";final Instant until=deadline();Enqueued original=app.enqueueRequirement(BUSINESS,"original",task,bot,1,until);check(original.status==Status.QUEUED&&count(s)==1);
        denied(ErrorCode.RATE_LIMITED,()->app.enqueueRequirement(OWNER,"limit",task,bot,1,until));
        sql(s,"UPDATE groups SET limits_bytes=? WHERE space_id='A' AND id=?","{\"maxRuns\":100,\"maxHandoffs\":1,\"maxTokens\":1000}".getBytes("UTF-8"),group);
        check(app.enqueueRequirement(BUSINESS,"original",task,bot,1,until).runId.equals(original.runId));
        denied(ErrorCode.COMMAND_CONFLICT,()->app.enqueueRequirement(BUSINESS,"original",task,bot,1,until.plusMillis(1)));check(count(s)==1);
        denied(ErrorCode.NOT_FOUND,()->app.getRequirementRun(new TrustedContext("B","business"),original.runId));
        denied(ErrorCode.FORBIDDEN,()->app.getRequirementRun(new TrustedContext("A","outsider"),original.runId));
        denied(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(new TrustedNodeContext("A","other-node","other"),original.runId));
        denied(ErrorCode.VERSION_CONFLICT,()->app.enqueueRequirement(BUSINESS,"bad-cas",task,bot,2,until));
        denied(ErrorCode.INVALID_PAYLOAD,()->app.enqueueRequirement(BUSINESS,"bad-expiry",task,bot,1,Instant.EPOCH));
        denied(ErrorCode.INVALID_PAYLOAD,()->app.enqueueRequirement(BUSINESS,"bad-long",task,bot,1,until.plusMillis(3600000)));
        for(String key:Arrays.asList("cap:business","cap:owner","workspace:business","workspace:owner","member:business","member:owner")){p.denied.add(key);denied(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(NODE,original.runId));p.denied.remove(key);}check(app.getRequirementRun(BUSINESS,original.runId).attemptId==null);
        phase="revoke-and-rebind";nodes.revokeRequirementNode(OWNER,group,1);denied(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(NODE,original.runId));nodes.authorizeRequirementNode(OWNER,group,"node","view",2,deadline());
        denied(ErrorCode.INPUT_CHANGED,()->app.claimRequirementRun(NODE,original.runId));check(app.cancelPendingRequirementRun(BUSINESS,original.runId,1).status==Status.CANCELLED);
        denied(ErrorCode.COMMAND_CONFLICT,()->app.claimRequirementRun(NODE,original.runId));
        phase="task-snapshot";Enqueued input=app.enqueueRequirement(BUSINESS,"input",task,bot,1,until);
        CreateTaskMessageRequest msg=new CreateTaskMessageRequest();msg.commandId="advance-input";msg.expectedVersion=1L;msg.text="业务补充需求";msg.artifactVersions=Collections.emptyList();
        check(new TaskApplication(s,p,TransactionObserver.NONE).execute(Operation.CREATE_TASK_MESSAGE,BUSINESS,task,null,null,JdbcApplicationStore.json(msg)).status==201);
        check(app.enqueueRequirement(BUSINESS,"input",task,bot,1,until).runId.equals(input.runId));check(app.enqueueRequirement(BUSINESS,"original",task,bot,1,until).status==Status.QUEUED);
        denied(ErrorCode.INPUT_CHANGED,()->app.claimRequirementRun(NODE,input.runId));app.cancelPendingRequirementRun(BUSINESS,input.runId,1);
        phase="membership-replay";Enqueued member=app.enqueueRequirement(BUSINESS,"member",task,bot,2,until);members(s,p,group,false);
        denied(ErrorCode.FORBIDDEN,()->app.enqueueRequirement(BUSINESS,"member",task,bot,2,until));denied(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(NODE,member.runId));members(s,p,group,true);
        denied(ErrorCode.INPUT_CHANGED,()->app.claimRequirementRun(NODE,member.runId));app.cancelPendingRequirementRun(BUSINESS,member.runId,1);
        phase="node-snapshot";Enqueued changed=app.enqueueRequirement(BUSINESS,"node-change",task,bot,2,until);nodes.observeDesktopNode(NODE,false,CAPS);denied(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(NODE,changed.runId));nodes.observeDesktopNode(NODE,true,CAPS);
        denied(ErrorCode.INPUT_CHANGED,()->app.claimRequirementRun(NODE,changed.runId));app.cancelPendingRequirementRun(BUSINESS,changed.runId,1);
        phase="offline-and-duplicate-claim";
        Enqueued lateOffline=app.enqueueRequirement(BUSINESS,"late-offline",task,bot,2,until);check(lateOffline.status==Status.QUEUED);
        sql(s,"UPDATE desktop_runtime_nodes SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY),last_seen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE space_id='A' AND id='node'");
        Run lateWait=app.claimRequirementRun(NODE,lateOffline.runId);check(lateWait.status==Status.WAITING_NODE&&lateWait.version==2&&lateWait.attemptId==null);
        check(app.claimRequirementRun(NODE,lateWait.id).version==2);check(app.cancelPendingRequirementRun(BUSINESS,lateWait.id,2).version==4);
        Enqueued waiting=app.enqueueRequirement(BUSINESS,"waiting",task,bot,2,until);check(waiting.status==Status.WAITING_NODE);Run pending=app.claimRequirementRun(NODE,waiting.runId);check(pending.status==Status.WAITING_NODE&&pending.attemptId==null);
        nodes.observeDesktopNode(NODE,true,CAPS);Run started=app.claimRequirementRun(NODE,waiting.runId),duplicate=app.claimRequirementRun(NODE,waiting.runId);
        check(started.status==Status.STARTING&&started.fence==1&&started.readOnly&&started.botVersionId.equals(pin)&&started.attemptId.equals(duplicate.attemptId)&&started.leaseId.equals(duplicate.leaseId)&&started.leaseExpiresAt.equals(duplicate.leaseExpiresAt));
        denied(ErrorCode.OUTCOME_UNKNOWN,()->app.cancelPendingRequirementRun(BUSINESS,started.id,2));
        sql(s,"UPDATE requirement_run_queue SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1000 MICROSECOND) WHERE space_id='A' AND id=?",started.id);
        Run unknown=app.claimRequirementRun(NODE,started.id);check(unknown.status==Status.OUTCOME_UNKNOWN&&unknown.attemptId.equals(started.attemptId));check(app.claimRequirementRun(NODE,started.id).leaseId.equals(started.leaseId));
        phase="pending-cancel-and-deadline";Enqueued cancellable=app.enqueueRequirement(BUSINESS,"cancel",task,bot,2,until);denied(ErrorCode.VERSION_CONFLICT,()->app.cancelPendingRequirementRun(BUSINESS,cancellable.runId,2));Run cancelled=app.cancelPendingRequirementRun(OWNER,cancellable.runId,1);check(cancelled.status==Status.CANCELLED&&cancelled.attemptId==null&&cancelled.version==3);check(app.cancelPendingRequirementRun(BUSINESS,cancellable.runId,3).id.equals(cancelled.id));
        Enqueued expired=app.enqueueRequirement(BUSINESS,"expired",task,bot,2,until);sql(s,"UPDATE requirement_run_queue SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY),deadline=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE space_id='A' AND id=?",expired.runId);
        denied(ErrorCode.COMMAND_EXPIRED,()->app.claimRequirementRun(NODE,expired.runId));check(app.getRequirementRun(BUSINESS,expired.runId).attemptId==null);app.cancelPendingRequirementRun(BUSINESS,expired.runId,1);
        phase="rollback-and-unknown";
        RequirementRunApplication rollback=app(s,p,stage->{if(stage==TransactionObserver.Stage.BEFORE_COMMIT)throw new IllegalStateException("PRIVATE");});long before=count(s);
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.enqueueRequirement(BUSINESS,"rollback",task,bot,2,until));check(count(s)==before);
        RequirementRunApplication lost=app(s,p,stage->{if(stage==TransactionObserver.Stage.AFTER_COMMIT)throw new IllegalStateException("PRIVATE");});
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.enqueueRequirement(BUSINESS,"lost-enqueue",task,bot,2,until));Enqueued committed=app.enqueueRequirement(BUSINESS,"lost-enqueue",task,bot,2,until);check(count(s)==before+1);
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.claimRequirementRun(NODE,committed.runId));check(app.getRequirementRun(BUSINESS,committed.runId).attemptId==null);
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.claimRequirementRun(NODE,committed.runId));Run readBack=app.getRequirementRun(BUSINESS,committed.runId),same=app.claimRequirementRun(NODE,committed.runId);check(readBack.status==Status.STARTING&&readBack.attemptId.equals(same.attemptId)&&readBack.leaseId.equals(same.leaseId));
        return f.put("denials",denials).put("unknownRun",unknown.id).put("committedRun",committed.runId).put("taskVersion",2).put("raceDeadline",deadline().toString());
    }
    public static void main(String[] args){int exit=1;try{
        check(args.length==1&&Arrays.asList("seed-v3","exercise","enqueue","claim","admission-business","admission-owner","reopen").contains(args[0]));ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int b;(b=System.in.read())!=-1;){check(bytes.size()<65536);bytes.write(b);}JsonNode input=JSON.readTree(bytes.toByteArray());exact(input,"db","fixture");check(input.path("fixture").isObject());
        LocalDatabaseConfig config=LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(input.get("db"))));
        try(HikariDataSource s=config.openPool()){
            DatabaseReadiness.requireConnection(s);Policy p=new Policy();ObjectNode f=(ObjectNode)input.get("fixture"),proof;
            if(args[0].equals("seed-v3")){phase="seed-v3";check(f.size()==0);check(MigrationRunner.configuration(s).target("3").load().migrate().migrationsExecuted==3);proof=seed(s,p).put("v3Facts",v3Facts(s)).put("migrations",3);}
            else {DatabaseReadiness.requireReady(s);if(args[0].equals("exercise"))proof=exercise(s,p,f);else {
                phase=args[0];RequirementRunApplication app=app(s,p,TransactionObserver.NONE);
                if(args[0].equals("enqueue")){Enqueued enqueued=app.enqueueRequirement(BUSINESS,"race-enqueue",id(f,"task"),id(f,"bot"),f.path("taskVersion").longValue(),Instant.parse(f.path("raceDeadline").textValue()));proof=JSON.createObjectNode().put("runId",enqueued.runId).put("createdAt",enqueued.createdAt.toString());}
                else if(args[0].equals("claim")){Run run=app.claimRequirementRun(NODE,id(f,"runId"));check(run.status==Status.STARTING&&run.version==2&&run.fence==1);proof=JSON.createObjectNode().put("runId",run.id).put("attemptId",run.attemptId).put("leaseId",run.leaseId).put("leaseExpiresAt",run.leaseExpiresAt.toString());}
                else if(args[0].startsWith("admission-")){TrustedContext actor=args[0].equals("admission-owner")?OWNER:BUSINESS;boolean winner=true;try{app.enqueueRequirement(actor,args[0],id(f,"task"),id(f,"bot"),2,Instant.parse(f.path("raceDeadline").textValue()));}catch(ApplicationFault fault){check(fault.code==ErrorCode.RATE_LIMITED);winner=false;}proof=JSON.createObjectNode().put("winner",winner);}
                else {Run unknown=app.getRequirementRun(BUSINESS,id(f,"unknownRun")),committed=app.getRequirementRun(BUSINESS,id(f,"committedRun"));check(unknown.status==Status.OUTCOME_UNKNOWN&&unknown.version==3&&committed.status==Status.STARTING&&committed.version==2&&committed.attemptId!=null&&taskVersion(s,id(f,"task"))==2);sql(s,"UPDATE groups SET limits_bytes=? WHERE space_id='A' AND id=?","{\"maxRuns\":4,\"maxHandoffs\":1,\"maxTokens\":1000}".getBytes("UTF-8"),id(f,"group"));proof=JSON.createObjectNode().put("restored",true).put("queueRows",count(s));}
            }}proof.put("status","verified").put("case",args[0]);System.out.println(proof);exit=0;
        }
    }catch(Exception failure){String code=failure instanceof ApplicationFault?((ApplicationFault)failure).code.wire():failure instanceof DatabaseFailure?((DatabaseFailure)failure).category().name():failure.getMessage()!=null&&failure.getMessage().matches("EXPECTED_[A-Z_]+_ACTUAL_[A-Z_]+")?failure.getMessage():"RUN_PROBE_ASSERTION";System.out.println("{\"status\":\"failed\",\"phase\":\""+phase+"\",\"category\":\""+code+"\"}");}System.exit(exit);}
}
