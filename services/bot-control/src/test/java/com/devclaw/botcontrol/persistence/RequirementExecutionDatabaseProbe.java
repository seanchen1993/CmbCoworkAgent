package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.adapters.local.*;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.application.RequirementRunApplication.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.persistence.RuntimeNodeDatabaseProbe.Policy;
import com.devclaw.botcontrol.ports.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.sql.*;
import java.time.*;
import java.util.*;

/** Disposable test main only; fixed node identity, independent random credential
 * per JVM action. No body node/owner/space/token or production listener. */
public final class RequirementExecutionDatabaseProbe {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private static final com.devclaw.botcontrol.validation.ContractBoundary BOUNDARY=new com.devclaw.botcontrol.validation.ContractBoundary();
    private static final TrustedContext OWNER=new TrustedContext("A","owner"),BUSINESS=new TrustedContext("A","business");
    private static final Set<Capability> CAPS=Collections.singleton(Capability.REQUIREMENTS_ANALYZE);
    private static String phase="input";private static int denials;
    private static void check(boolean value){if(!value)throw new IllegalStateException("EXECUTION_ASSERTION");}
    private static void exact(JsonNode node,String... keys){Set<String> names=new HashSet<String>();node.fieldNames().forEachRemaining(names::add);check(node.isObject()&&names.equals(new HashSet<String>(Arrays.asList(keys))));}
    private static void denied(ErrorCode code,Runnable work){try{work.run();throw new IllegalStateException("MISSING_DENIAL");}catch(ApplicationFault f){if(f.code!=code)throw new IllegalStateException("EXPECTED_"+code.wire()+"_ACTUAL_"+f.code.wire());check(f.getCause()==null);denials++;}}
    private static final class Adapter {
        final LocalNodeCredentialRegistry registry;final LocalAuthenticatedNodeAdapter adapter;final LocalNodeCredentialRegistry.Session session;
        Adapter(HikariDataSource source,Policy policy,TransactionObserver observer){
            byte[] random=new byte[32];new java.security.SecureRandom().nextBytes(random);StringBuilder token=new StringBuilder("dcn1_");for(byte b:random)token.append(String.format(Locale.ROOT,"%02x",b&255));
            Instant now=Instant.ofEpochMilli(System.currentTimeMillis());registry=new LocalNodeCredentialRegistry(Clock.systemUTC(),Collections.singletonList(new LocalNodeCredentialRegistry.Binding("A","node","owner",token.toString(),now.plusSeconds(600))));
            adapter=new LocalAuthenticatedNodeAdapter(registry,new RuntimeNodeApplication(source,policy,policy,observer),app(source,policy,observer));session=adapter.authenticate("Bearer "+token);
        }
        Started start(Run r){return adapter.start(session,r.id,r.attemptId,r.leaseId,r.fence);}
        Run renew(Run r){return adapter.renew(session,r.id,r.attemptId,r.leaseId,r.fence);}
        Result settle(Run r,String outcome,String text){return adapter.settle(session,r.id,r.attemptId,r.leaseId,r.fence,outcome,text);}
    }
    private static RequirementRunApplication app(HikariDataSource source,Policy policy,TransactionObserver observer){return new RequirementRunApplication(source,policy,policy,observer);}
    private static void sql(HikariDataSource source,String sql,Object... values)throws Exception{try(Connection c=source.getConnection();PreparedStatement p=c.prepareStatement(sql)){c.setAutoCommit(false);p.setQueryTimeout(2);for(int i=0;i<values.length;i++)p.setObject(i+1,values[i]);check(p.executeUpdate()==1);c.commit();}}
    private static ObjectNode input(HikariDataSource source,Run run)throws Exception{try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);JdbcTaskStore tasks=new JdbcTaskStore(c,"A");Task task=tasks.task(run.taskId);check(task.version==run.taskVersion);ObjectNode n=JSON.createObjectNode();n.set("bot",JSON.valueToTree(db.bot(run.botId)));n.set("botVersion",JSON.valueToTree(db.version(run.botVersionId)));n.set("group",JSON.valueToTree(db.group(run.groupId)));n.set("task",JSON.valueToTree(task));n.set("messages",JSON.valueToTree(tasks.requirementMessages(task,run.botId)));c.rollback();return n;}}
    private static ObjectNode seed(HikariDataSource source,Policy policy)throws Exception{
        return seed(source,policy,false);
    }
    private static ObjectNode seed(HikariDataSource source,Policy policy,boolean clarified)throws Exception{
        ObjectNode ids=RuntimeNodeDatabaseProbe.seed(source,policy);Adapter a=new Adapter(source,policy,TransactionObserver.NONE);a.adapter.observe(a.session,true,CAPS);
        new RuntimeNodeApplication(source,policy,policy,TransactionObserver.NONE).authorizeRequirementNode(OWNER,ids.path("group").asText(),"node","view",0,Instant.ofEpochMilli(System.currentTimeMillis()+1200000));
        if(clarified){CreateTaskMessageRequest message=new CreateTaskMessageRequest();message.commandId="seed-clarification";message.expectedVersion=1L;message.text="CLARIFICATION_SENTINEL 只查本人可见账户，不代业务确认";message.artifactVersions=Collections.emptyList();check(new TaskApplication(source,policy,TransactionObserver.NONE).execute(Operation.CREATE_TASK_MESSAGE,BUSINESS,ids.path("task").asText(),null,null,JdbcApplicationStore.json(message)).status==201);}
        Run run=enqueue(source,policy,a,ids,"execution-seed");ObjectNode proof=JSON.createObjectNode();proof.set("run",JSON.valueToTree(run));proof.set("input",input(source,run));return proof;
    }
    private static Run enqueue(HikariDataSource source,Policy policy,Adapter a,ObjectNode ids,String command){
        long version;try(Connection c=source.getConnection()){c.setAutoCommit(false);version=new JdbcTaskStore(c,"A").task(ids.path("task").asText()).version;c.rollback();}catch(SQLException f){throw JdbcApplicationStore.corrupt();}
        Enqueued q=app(source,policy,TransactionObserver.NONE).enqueueRequirement(BUSINESS,command,ids.path("task").asText(),ids.path("bot").asText(),version,Instant.ofEpochMilli(System.currentTimeMillis()+1200000));return a.adapter.claim(a.session,q.runId);
    }
    private static ObjectNode ids(Run r){return JSON.createObjectNode().put("task",r.taskId).put("bot",r.botId);}
    private static Task task(HikariDataSource source,String id){try(Connection c=source.getConnection()){c.setAutoCommit(false);Task value=new JdbcTaskStore(c,"A").task(id);c.rollback();return value;}catch(SQLException f){throw JdbcApplicationStore.corrupt();}}
    private static List<TaskMessageResult> messages(HikariDataSource source,Task task,String bot){try(Connection c=source.getConnection()){c.setAutoCommit(false);List<TaskMessageResult> value=new JdbcTaskStore(c,"A").requirementMessages(task,bot);c.rollback();return value;}catch(SQLException f){throw JdbcApplicationStore.corrupt();}}
    private static TaskMessageResult append(HikariDataSource source,Policy policy,String task,String bot,String text){
        CreateTaskMessageRequest r=new CreateTaskMessageRequest();r.commandId=UUID.randomUUID().toString();r.expectedVersion=task(source,task).version;r.text=text;r.targetBotId=bot;r.artifactVersions=Collections.emptyList();
        ApplicationResponse response=new TaskApplication(source,policy,TransactionObserver.NONE).execute(Operation.CREATE_TASK_MESSAGE,BUSINESS,task,null,null,JdbcApplicationStore.json(r));check(response.status==201);return BOUNDARY.readResponse("createTaskMessage",201,response.body(),TaskMessageResult.class);
    }
    private static ObjectNode messageBounds(HikariDataSource source,Policy policy)throws Exception{
        phase="message-seed";ObjectNode ids=RuntimeNodeDatabaseProbe.seed(source,policy);String taskId=ids.path("task").asText(),bot=ids.path("bot").asText();Task initial=task(source,taskId);check(messages(source,initial,bot).isEmpty());
        TaskMessageResult first=append(source,policy,taskId,null,"CLARIFICATION_SENTINEL 只查本人可见账户，不代业务确认");
        TaskMessageResult targeted=append(source,policy,taskId,bot,"TARGETED_SENTINEL");Task frozen=task(source,taskId);
        check(messages(source,initial,bot).isEmpty());List<TaskMessageResult> visible=messages(source,frozen,bot);check(visible.size()==2&&visible.get(0).taskVersion==2&&visible.get(1).taskVersion==3&&visible.get(0).message.authorPrincipalId.equals("business"));
        phase="message-scope-target";sql(source,"UPDATE task_messages SET target_bot_id='another-bot' WHERE space_id='A' AND id=?",targeted.message.id);check(messages(source,frozen,bot).size()==1);
        try(Connection c=source.getConnection()){c.setAutoCommit(false);TaskMessageResult other=new TaskMessageResult();other.taskVersion=2L;other.message=new TaskMessage();other.message.id=UUID.randomUUID().toString();other.message.spaceId="B";other.message.taskId=taskId;other.message.authorPrincipalId="business";other.message.text="OTHER_SPACE_SENTINEL";other.message.artifactVersions=Collections.emptyList();other.message.createdAt=first.message.createdAt;new JdbcTaskStore(c,"B").message(other,null);
            other.message.id=UUID.randomUUID().toString();other.message.spaceId="A";other.message.taskId="another-task";other.message.text="OTHER_TASK_SENTINEL";new JdbcTaskStore(c,"A").message(other,null);c.commit();}
        check(messages(source,frozen,bot).size()==1);sql(source,"UPDATE task_messages SET target_bot_id=NULL WHERE space_id='A' AND id=?",targeted.message.id);
        phase="message-count-bound";for(int i=2;i<50;i++)append(source,policy,taskId,null,"bounded-"+i);Task fifty=task(source,taskId);check(messages(source,fifty,bot).size()==50);
        append(source,policy,taskId,null,"fifty-first");Task overCount=task(source,taskId);denied(ErrorCode.RATE_LIMITED,()->messages(source,overCount,bot));check(messages(source,fifty,bot).size()==50);
        // Fixed test fixture hides old messages from this Bot, preserving their
        // bytes. New public messages provide the exact text budget boundary.
        try(Connection c=source.getConnection();PreparedStatement p=c.prepareStatement("UPDATE task_messages SET target_bot_id='another-bot' WHERE space_id='A' AND task_id=?")){c.setAutoCommit(false);p.setQueryTimeout(2);p.setString(1,taskId);check(p.executeUpdate()==51);c.commit();}
        phase="message-character-bound";String bulk=String.join("",Collections.nCopies(15000,"中"));for(int i=0;i<3;i++)append(source,policy,taskId,bot,bulk);Task belowChars=task(source,taskId);check(messages(source,belowChars,bot).size()==3);
        TaskMessageResult fourth=append(source,policy,taskId,bot,bulk);Task overChars=task(source,taskId);denied(ErrorCode.RATE_LIMITED,()->messages(source,overChars,bot));
        sql(source,"UPDATE task_messages SET target_bot_id='another-bot' WHERE space_id='A' AND id=?",fourth.message.id);
        phase="message-artifact-refusal";ArtifactVersionRef ref=new ArtifactVersionRef();ref.artifactId="artifact";ref.versionId="version";ref.digest="sha256:"+String.join("",Collections.nCopies(64,"0"));first.message.artifactVersions=Collections.singletonList(ref);
        sql(source,"UPDATE task_messages SET target_bot_id=NULL,body_bytes=? WHERE space_id='A' AND id=?",BOUNDARY.writeResponse("createTaskMessage",201,first),first.message.id);denied(ErrorCode.INVALID_PAYLOAD,()->messages(source,overChars,bot));
        first.message.artifactVersions=Collections.emptyList();byte[] original=BOUNDARY.writeResponse("createTaskMessage",201,first);sql(source,"UPDATE task_messages SET body_bytes=? WHERE space_id='A' AND id=?",original,first.message.id);
        phase="message-storage-crosscheck";sql(source,"UPDATE task_messages SET author_principal_id='other' WHERE space_id='A' AND id=?",first.message.id);denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->messages(source,overChars,bot));sql(source,"UPDATE task_messages SET author_principal_id='business',body_bytes=? WHERE space_id='A' AND id=?","{}".getBytes("UTF-8"),first.message.id);denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->messages(source,overChars,bot));sql(source,"UPDATE task_messages SET body_bytes=? WHERE space_id='A' AND id=?",original,first.message.id);check(messages(source,overChars,bot).size()==4);
        return JSON.createObjectNode().put("messagesBounded",true).put("scopeAndTargetFiltered",true).put("frozenVersionFiltered",true).put("artifactRejected",true).put("storageSchemaCrosschecked",true).put("denials",denials);
    }
    private static String v4Facts(HikariDataSource source)throws Exception{
        java.security.MessageDigest digest=java.security.MessageDigest.getInstance("SHA-256");
        try(DataOutputStream out=new DataOutputStream(new java.security.DigestOutputStream(new OutputStream(){public void write(int b){}},digest));Connection c=source.getConnection()){
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);c.setAutoCommit(false);
            for(String table:DatabaseReadiness.TABLES){if(table.equals("requirement_run_results"))continue;out.writeUTF(table);List<String> rows=new ArrayList<String>();
                try(PreparedStatement p=c.prepareStatement("SELECT * FROM "+table+(table.equals("bot_schema_history")?" WHERE version IN ('1','2','3','4')":""))){p.setQueryTimeout(2);try(ResultSet r=p.executeQuery()){out.writeInt(r.getMetaData().getColumnCount());while(r.next()){ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream row=new DataOutputStream(bytes);for(int i=1;i<=r.getMetaData().getColumnCount();i++){byte[] value=r.getBytes(i);row.writeInt(value==null?-1:value.length);if(value!=null)row.write(value);}rows.add(Base64.getEncoder().encodeToString(bytes.toByteArray()));}}}
                Collections.sort(rows);for(String row:rows){byte[] bytes=row.getBytes("US-ASCII");out.writeInt(bytes.length);out.write(bytes);}out.writeInt(-1);
            }c.rollback();
        }StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();
    }
    private static ObjectNode exercise(HikariDataSource source,Policy policy,String existingRun)throws Exception{
        phase="seed";RequirementRunApplication app=app(source,policy,TransactionObserver.NONE);String runId=existingRun==null?seed(source,policy).path("run").path("id").asText():existingRun;
        Adapter a=new Adapter(source,policy,TransactionObserver.NONE);Run ticket=app.getRequirementRun(BUSINESS,runId);
        phase="start-denials";denied(ErrorCode.COMMAND_CONFLICT,()->a.adapter.start(a.session,ticket.id,ticket.attemptId,ticket.leaseId,2));
        denied(ErrorCode.COMMAND_CONFLICT,()->a.adapter.start(a.session,ticket.id,"wrong",ticket.leaseId,1));
        for(String key:Arrays.asList("cap:business","cap:owner","workspace:business","workspace:owner","member:business")){policy.denied.add(key);denied(ErrorCode.FORBIDDEN,()->a.start(ticket));policy.denied.remove(key);}
        denied(ErrorCode.COMMAND_CONFLICT,()->a.settle(ticket,"succeeded","premature"));denied(ErrorCode.INVALID_PAYLOAD,()->a.settle(ticket,"failed","SECRET_EXCEPTION"));
        phase="start-rollback-and-lost";Adapter rollback=new Adapter(source,policy,stage->{if(stage==TransactionObserver.Stage.BEFORE_COMMIT)throw new IllegalStateException("PRIVATE");});
        Adapter lost=new Adapter(source,policy,stage->{if(stage==TransactionObserver.Stage.AFTER_COMMIT)throw new IllegalStateException("PRIVATE");});
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.start(ticket));check(app.getRequirementRun(BUSINESS,ticket.id).status==Status.STARTING);
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.start(ticket));
        phase="start-renew";Started started=a.start(ticket);check(started.run.status==Status.RUNNING&&started.run.attemptId.equals(ticket.attemptId)&&started.input.task.id.equals(ticket.taskId));
        Started duplicate=a.start(ticket);check(duplicate.run.version==started.run.version&&duplicate.run.leaseExpiresAt.equals(started.run.leaseExpiresAt));
        denied(ErrorCode.COMMAND_CONFLICT,()->a.adapter.claim(a.session,ticket.id));Run renewed=a.renew(ticket);check(renewed.status==Status.RUNNING&&renewed.version==started.run.version+1&&renewed.leaseId.equals(ticket.leaseId)&&!renewed.leaseExpiresAt.isBefore(started.run.leaseExpiresAt));
        for(String key:Arrays.asList("cap:business","workspace:owner")){policy.denied.add(key);denied(ErrorCode.FORBIDDEN,()->a.renew(ticket));denied(ErrorCode.FORBIDDEN,()->a.settle(ticket,"succeeded","no"));policy.denied.remove(key);}
        phase="renew-rollback";denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.renew(ticket));check(app.getRequirementRun(BUSINESS,ticket.id).version==renewed.version);
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.renew(ticket));check(app.getRequirementRun(BUSINESS,ticket.id).version==renewed.version+1);
        phase="atomic-rollback";
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.settle(ticket,"succeeded","原子结果 中文"));check(app.getRequirementResult(BUSINESS,ticket.id)==null&&app.getRequirementRun(BUSINESS,ticket.id).status==Status.RUNNING);
        phase="lost-receipt";
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.settle(ticket,"succeeded","原子结果 中文"));Result result=app.getRequirementResult(BUSINESS,ticket.id);check(result!=null&&result.text.equals("原子结果 中文"));Result replay=a.settle(ticket,"succeeded",result.text);check(replay.settledAt.equals(result.settledAt));
        denied(ErrorCode.COMMAND_CONFLICT,()->a.settle(ticket,"succeeded","different"));denied(ErrorCode.COMMAND_CONFLICT,()->a.settle(ticket,"failed","EXECUTION_FAILED"));denied(ErrorCode.COMMAND_CONFLICT,()->a.start(ticket));denied(ErrorCode.COMMAND_CONFLICT,()->a.renew(ticket));
        denied(ErrorCode.FORBIDDEN,()->app.getRequirementResult(new TrustedContext("A","outsider"),ticket.id));
        phase="terminal-capacity";Run failed=enqueue(source,policy,a,ids(ticket),"failed");a.start(failed);Result failedResult=a.settle(failed,"failed","EMPTY_OUTPUT");check(failedResult.text.equals("EMPTY_OUTPUT"));
        phase="expired-unknown";Run expiring=enqueue(source,policy,a,ids(ticket),"expire");a.start(expiring);sql(source,"UPDATE requirement_run_queue SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1000 MICROSECOND) WHERE space_id='A' AND id=?",expiring.id);
        denied(ErrorCode.OUTCOME_UNKNOWN,()->a.renew(expiring));Run unknown=app.getRequirementRun(BUSINESS,expiring.id);check(unknown.status==Status.OUTCOME_UNKNOWN&&unknown.attemptId.equals(expiring.attemptId));denied(ErrorCode.OUTCOME_UNKNOWN,()->a.start(expiring));denied(ErrorCode.OUTCOME_UNKNOWN,()->a.settle(expiring,"succeeded","no"));check(app.getRequirementResult(BUSINESS,expiring.id)==null);
        denied(ErrorCode.RATE_LIMITED,()->app.enqueueRequirement(BUSINESS,"no-retry",ticket.taskId,ticket.botId,1,Instant.ofEpochMilli(System.currentTimeMillis()+1200000)));
        phase="current-grant-revocation";
        sql(source,"UPDATE groups SET limits_bytes=? WHERE space_id='A' AND id=?","{\"maxRuns\":100,\"maxHandoffs\":1,\"maxTokens\":1000}".getBytes("UTF-8"),ticket.groupId);
        Run revokedRunning=enqueue(source,policy,a,ids(ticket),"revoked-running");a.start(revokedRunning);Run revokedStarting=enqueue(source,policy,a,ids(ticket),"revoked-starting");
        RuntimeNodeApplication nodes=new RuntimeNodeApplication(source,policy,policy,TransactionObserver.NONE);nodes.revokeRequirementNode(OWNER,ticket.groupId,1);
        denied(ErrorCode.FORBIDDEN,()->a.start(revokedStarting));denied(ErrorCode.FORBIDDEN,()->a.renew(revokedRunning));denied(ErrorCode.FORBIDDEN,()->a.settle(revokedRunning,"succeeded","no"));check(app.getRequirementResult(BUSINESS,revokedRunning.id)==null);
        // A persisted terminal result remains readable/replayable after withdrawal.
        check(a.settle(ticket,"succeeded",result.text).settledAt.equals(result.settledAt));
        nodes.authorizeRequirementNode(OWNER,ticket.groupId,"node","view",2,Instant.ofEpochMilli(System.currentTimeMillis()+1200000));
        denied(ErrorCode.INPUT_CHANGED,()->a.start(revokedStarting));
        phase="current-task-input-change";Run changedRunning=enqueue(source,policy,a,ids(ticket),"changed-running");a.start(changedRunning);Run changedStarting=enqueue(source,policy,a,ids(ticket),"changed-starting");
        CreateTaskMessageRequest message=new CreateTaskMessageRequest();message.commandId="change-execution-input";message.expectedVersion=1L;message.text="补充需求";message.artifactVersions=Collections.emptyList();
        check(new TaskApplication(source,policy,TransactionObserver.NONE).execute(Operation.CREATE_TASK_MESSAGE,BUSINESS,ticket.taskId,null,null,JdbcApplicationStore.json(message)).status==201);
        denied(ErrorCode.INPUT_CHANGED,()->a.start(changedStarting));denied(ErrorCode.INPUT_CHANGED,()->a.renew(changedRunning));denied(ErrorCode.INPUT_CHANGED,()->a.settle(changedRunning,"succeeded","no"));check(app.getRequirementResult(BUSINESS,changedRunning.id)==null);
        phase="credential-revoke";a.registry.revoke("A","node");denied(ErrorCode.UNAUTHENTICATED,()->a.start(ticket));denied(ErrorCode.UNAUTHENTICATED,()->a.renew(ticket));denied(ErrorCode.UNAUTHENTICATED,()->a.settle(ticket,"succeeded",result.text));denied(ErrorCode.UNAUTHENTICATED,()->a.adapter.getResult(a.session,ticket.id));
        ObjectNode proof=JSON.createObjectNode().put("denials",denials).put("atomicResult",true).put("lostReceiptRecovered",true).put("capacityReleased",true).put("expiredUnknownReserved",true);proof.set("result",JSON.valueToTree(result));return proof;
    }
    public static void main(String[] args){int exit=1;try{
        check(args.length==1&&Arrays.asList("seed-v4","verify-v4","seed","seed-clarified","messages","exercise","start","renew","settle","read").contains(args[0]));ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int b;(b=System.in.read())!=-1;){check(bytes.size()<131072);bytes.write(b);}JsonNode request=JSON.readTree(bytes.toByteArray());exact(request,"db","fixture");JsonNode fixture=request.get("fixture");check(fixture.isObject());
        LocalDatabaseConfig config=LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(request.get("db"))));try(HikariDataSource source=config.openPool()){
            DatabaseReadiness.requireConnection(source);Policy policy=new Policy();ObjectNode proof;
            if(args[0].equals("seed-v4")){phase="seed-v4";exact(fixture);check(MigrationRunner.configuration(source).target("4").load().migrate().migrationsExecuted==4);proof=seed(source,policy);proof.put("v4Facts",v4Facts(source));}
            else {DatabaseReadiness.requireReady(source);
            if(args[0].equals("verify-v4")){phase="verify-v4";exact(fixture,"v4Facts");check(fixture.path("v4Facts").asText().equals(v4Facts(source)));proof=JSON.createObjectNode().put("v4Preserved",true);}
            else if(args[0].equals("messages")){exact(fixture);proof=messageBounds(source,policy);}
            else if(args[0].equals("seed")||args[0].equals("seed-clarified")){exact(fixture);proof=seed(source,policy,args[0].equals("seed-clarified"));}
            else if(args[0].equals("exercise")){if(fixture.size()==0)exact(fixture);else exact(fixture,"runId");proof=exercise(source,policy,fixture.size()==0?null:fixture.path("runId").asText());}
            else{
                phase=args[0];if(args[0].equals("settle"))exact(fixture,"runId","outcome","text");else exact(fixture,"runId");check(fixture.path("runId").isTextual());
                RequirementRunApplication app=app(source,policy,TransactionObserver.NONE);Run run=app.getRequirementRun(BUSINESS,fixture.path("runId").textValue());Adapter a=new Adapter(source,policy,TransactionObserver.NONE);proof=JSON.createObjectNode();
                if(args[0].equals("start")){Started value=a.start(run);proof.set("run",JSON.valueToTree(value.run));proof.set("input",JSON.valueToTree(value.input));}
                else if(args[0].equals("renew"))proof.set("run",JSON.valueToTree(a.renew(run)));
                else if(args[0].equals("settle")){check(fixture.path("outcome").isTextual()&&fixture.path("text").isTextual());proof.set("result",JSON.valueToTree(a.settle(run,fixture.path("outcome").textValue(),fixture.path("text").textValue())));}
                else {proof.set("run",JSON.valueToTree(run));proof.set("result",JSON.valueToTree(a.adapter.getResult(a.session,run.id)));}
            }}
            proof.put("status","verified").put("case",args[0]);System.out.println(proof);exit=0;
        }
    }catch(Exception f){String code=f instanceof ApplicationFault?((ApplicationFault)f).code.wire():f instanceof DatabaseFailure?((DatabaseFailure)f).category().name():f.getMessage()!=null&&f.getMessage().matches("EXPECTED_[A-Z_]+_ACTUAL_[A-Z_]+")?f.getMessage():"EXECUTION_ASSERTION";System.out.println("{\"status\":\"failed\",\"phase\":\""+phase+"\",\"category\":\""+code+"\"}");}System.exit(exit);}
}
