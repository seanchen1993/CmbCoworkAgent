package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.application.GroupMemoryValues.*;
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
import java.security.*;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** Fixed disposable fixtures only, private app-password stdin, no SQL selection. */
public final class GroupMemoryDatabaseProbe {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private static final TrustedContext OWNER=new TrustedContext("A","owner"),BUSINESS=new TrustedContext("A","business");
    private static final TrustedNodeContext NODE=new TrustedNodeContext("A","node","owner");
    private static String phase="input";
    private static void check(boolean value){if(!value)throw new IllegalStateException();}
    private static void exact(JsonNode node,String... keys){Set<String> actual=new HashSet<String>();node.fieldNames().forEachRemaining(actual::add);check(node.isObject()&&actual.equals(new HashSet<String>(Arrays.asList(keys))));}
    private static String id(JsonNode node,String field){check(node.path(field).isTextual());return GroupMemoryValues.id(node.path(field).textValue());}
    private static Source manual(){return GroupMemoryValues.source(JSON.createObjectNode().put("kind","manual"));}
    private static void denied(ErrorCode code,Runnable action){try{action.run();throw new IllegalStateException();}catch(ApplicationFault failure){check(failure.code==code&&failure.getCause()==null);}}
    private static Instant expiry(){return Instant.ofEpochMilli(System.currentTimeMillis()+600000);}
    private static String facts(HikariDataSource source,boolean v5)throws Exception {
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(Connection c=source.getConnection();DataOutputStream out=new DataOutputStream(new DigestOutputStream(new OutputStream(){public void write(int value){}},digest))){
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);c.setAutoCommit(false);
            for(String table:DatabaseReadiness.TABLES){if(v5&&Arrays.asList("group_memory_revisions","group_memories","group_memory_commands","requirement_run_memory_snapshots").contains(table))continue;
                List<String> rows=new ArrayList<String>();out.writeUTF(table);
                try(PreparedStatement p=c.prepareStatement("SELECT * FROM "+table+(v5&&table.equals("bot_schema_history")?" WHERE version IN ('1','2','3','4','5')":""))){p.setQueryTimeout(2);try(ResultSet r=p.executeQuery()){out.writeInt(r.getMetaData().getColumnCount());while(r.next()){ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream row=new DataOutputStream(bytes);for(int i=1;i<=r.getMetaData().getColumnCount();i++){byte[] value=r.getBytes(i);row.writeInt(value==null?-1:value.length);if(value!=null)row.write(value);}rows.add(Base64.getEncoder().encodeToString(bytes.toByteArray()));}}}
                Collections.sort(rows);for(String row:rows){out.writeUTF(row);}out.writeBoolean(false);
            }c.rollback();
        }
        StringBuilder hex=new StringBuilder();for(byte value:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",value&255));return hex.toString();
    }
    private static Run v5Start(HikariDataSource source,Policy policy,ObjectNode ids,String command)throws Exception {
        RequirementRunApplication app=new RequirementRunApplication(source,policy,policy,TransactionObserver.NONE);Enqueued queued=app.enqueueRequirement(BUSINESS,command,ids.path("task").asText(),ids.path("bot").asText(),1,expiry());Run claimed=app.claimRequirementRun(NODE,queued.runId);
        // This is exactly the old V5 state transition, before memory existed.
        try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);db.group(claimed.groupId);JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,"A");Run running=runs.start(runs.run(claimed.id),db.now().toInstant());c.commit();return running;}
    }
    private static Run migrationFixtureWindow(HikariDataSource source,Run seeded)throws Exception {
        // Disposable migration fixture ONLY. Seed -> migrate -> verify -> JVM boot
        // is not a production node execution interval. Keep this one known old
        // running attempt alive up to its EXISTING finite ten-minute deadline;
        // no production lease duration, terminal row, ticket or deadline changes.
        try(Connection c=source.getConnection()){
            c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);check(db.group(seeded.groupId)!=null);JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,"A");Run old=runs.run(seeded.id);Instant now=db.now().toInstant();
            check(old!=null&&old.spaceId.equals("A")&&old.status==Status.RUNNING&&old.attemptId.equals(seeded.attemptId)&&old.leaseId.equals(seeded.leaseId)&&old.version==seeded.version&&old.deadline.isAfter(now)&&!old.deadline.isAfter(now.plusSeconds(600)));
            try(PreparedStatement p=c.prepareStatement("UPDATE requirement_run_queue SET lease_expires_at=? WHERE space_id='A' AND id=? AND status='running' AND attempt_id=? AND lease_id=? AND version=?")){
                p.setQueryTimeout(2);p.setTimestamp(1,java.sql.Timestamp.from(old.deadline),Calendar.getInstance(TimeZone.getTimeZone("UTC")));p.setString(2,old.id);p.setString(3,old.attemptId);p.setString(4,old.leaseId);p.setLong(5,old.version);check(p.executeUpdate()==1);
            }
            Run fixture=runs.run(old.id);check(fixture.leaseExpiresAt.equals(old.deadline)&&fixture.deadline.equals(seeded.deadline)&&fixture.attemptId.equals(seeded.attemptId));c.commit();return fixture;
        }
    }
    private static ObjectNode seedV5(HikariDataSource source)throws Exception {
        phase="seed-v5";check(MigrationRunner.configuration(source).target("5").load().migrate().migrationsExecuted==5);Policy policy=new Policy();ObjectNode ids=RuntimeNodeDatabaseProbe.seed(source,policy);
        BotConfig config;Group group;try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);config=db.version(ids.path("botVersion").asText()).config;group=db.group(ids.path("group").asText());c.rollback();}
        config.memoryPolicy=BotConfigMemoryPolicy.EXPLICIT_ONLY;CreateBotVersionRequest version=new CreateBotVersionRequest();version.commandId="v5-explicit-version";version.expectedVersion=1L;version.config=config;
        BotApplication bots=new BotApplication(source,policy);ApplicationResponse response=bots.execute(Operation.CREATE_BOT_VERSION,OWNER,ids.path("bot").asText(),JdbcApplicationStore.json(version));check(response.status==201);
        BotResult published=new com.devclaw.botcontrol.validation.ContractBoundary().readResponse("createBotVersion",201,response.body(),BotResult.class);
        UpdateGroupMembersRequest update=new UpdateGroupMembersRequest();update.commandId="v5-adopt-explicit";update.expectedVersion=1L;update.members=group.members;update.bots=group.bots;update.bots.get(0).botVersionId=published.botVersion.id;check(bots.execute(Operation.UPDATE_GROUP_MEMBERS,OWNER,group.id,JdbcApplicationStore.json(update)).status==200);
        RuntimeNodeApplication nodes=new RuntimeNodeApplication(source,policy,policy,TransactionObserver.NONE);nodes.observeDesktopNode(NODE,true,Collections.singleton(Capability.REQUIREMENTS_ANALYZE));nodes.authorizeRequirementNode(OWNER,ids.path("group").asText(),"node","view",0,expiry());
        Run terminal=v5Start(source,policy,ids,"v5-terminal");
        try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);db.group(terminal.groupId);JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,"A");runs.settle(runs.run(terminal.id),db.now().toInstant(),"succeeded","V5_PERSISTED_RESULT");c.commit();}
        Run running=migrationFixtureWindow(source,v5Start(source,policy,ids,"v5-running"));ObjectNode result=JSON.createObjectNode();result.set("running",JSON.valueToTree(running));result.set("terminal",JSON.valueToTree(terminal));result.put("v5RunningFixtureWindow",true);result.put("v5Facts",facts(source,true));return result;
    }
    private static ObjectNode verifyV5(HikariDataSource source,JsonNode fixture)throws Exception {
        phase="verify-v5";exact(fixture,"v5Facts","runId","terminalId");check(fixture.path("v5Facts").asText().equals(facts(source,true)));Policy policy=new Policy();RequirementRunApplication app=new RequirementRunApplication(source,policy,policy,TransactionObserver.NONE);
        Run run=app.getRequirementRun(BUSINESS,id(fixture,"runId"));check(run.status==Status.RUNNING);try(Connection c=source.getConnection()){JdbcGroupMemoryStore.Frozen frozen=new JdbcGroupMemoryStore(c,"A").snapshot(run);check(frozen.found&&frozen.value==null);}
        check(app.getRequirementResult(BUSINESS,id(fixture,"terminalId")).text.equals("V5_PERSISTED_RESULT"));return JSON.createObjectNode().put("v5FactsPreserved",true).put("historicalRunningNull",true).put("oldResultPreserved",true);
    }
    private static ObjectNode faults(HikariDataSource source,JsonNode fixture)throws Exception {
        phase="write-faults";exact(fixture,"groupId");String group=id(fixture,"groupId");Policy policy=new Policy();GroupMemoryApplication app=new GroupMemoryApplication(source,policy,TransactionObserver.NONE);String before=facts(source,false);
        GroupMemoryApplication rollback=new GroupMemoryApplication(source,policy,stage->{if(stage==TransactionObserver.Stage.BEFORE_COMMIT)throw new IllegalStateException();});
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.createGroupMemory(OWNER,group,"memory-rollback","ROLLBACK_SENTINEL",manual()));check(before.equals(facts(source,false)));
        GroupMemoryApplication lost=new GroupMemoryApplication(source,policy,stage->{if(stage==TransactionObserver.Stage.AFTER_COMMIT)throw new IllegalStateException();});
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.createGroupMemory(OWNER,group,"memory-lost","LOST_RECEIPT_SENTINEL",manual()));Changed replay=app.createGroupMemory(OWNER,group,"memory-lost","LOST_RECEIPT_SENTINEL",manual());
        check(replay.revision==app.listGroupMemories(OWNER,group).revision);check(GroupMemoryValues.encode(replay).equals(GroupMemoryValues.encode(app.createGroupMemory(OWNER,group,"memory-lost","LOST_RECEIPT_SENTINEL",manual()))));
        policy.denied.add("member:owner");denied(ErrorCode.FORBIDDEN,()->app.createGroupMemory(OWNER,group,"memory-lost","LOST_RECEIPT_SENTINEL",manual()));policy.denied.clear();
        return JSON.createObjectNode().put("allFactsRollback",true).put("lostReceiptRecovered",true).put("replayCurrentActorRequired",true);
    }
    private static ObjectNode expire(HikariDataSource source,JsonNode fixture)throws Exception {
        phase="expire";exact(fixture,"runId");String id=id(fixture,"runId");try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore db=new JdbcApplicationStore(c,"A",TransactionObserver.NONE);JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,"A");String group=runs.groupId(id);check(group!=null);db.group(group);Run run=runs.run(id);check(run.status==Status.RUNNING);
            try(PreparedStatement p=c.prepareStatement("UPDATE requirement_run_queue SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1000 MICROSECOND) WHERE space_id='A' AND id=? AND status='running'")){p.setQueryTimeout(2);p.setString(1,id);check(p.executeUpdate()==1);}c.commit();}
        return JSON.createObjectNode().put("expired",true);
    }
    private static ObjectNode otherSpace(HikariDataSource source,JsonNode fixture)throws Exception {
        phase="other-space";exact(fixture,"groupId","taskId","memoryId");String groupId=id(fixture,"groupId"),taskId=id(fixture,"taskId"),memoryId=id(fixture,"memoryId");String only=UUID.randomUUID().toString();
        try(Connection c=source.getConnection()){c.setAutoCommit(false);JdbcApplicationStore a=new JdbcApplicationStore(c,"A",TransactionObserver.NONE),b=new JdbcApplicationStore(c,"B",TransactionObserver.NONE);Group group=a.group(groupId);check(group!=null);Task task=new JdbcTaskStore(c,"A").task(taskId);check(task!=null&&groupId.equals(task.groupId));Bot bot=a.bot(group.bots.get(0).botId);BotVersion current=a.version(bot.currentBotVersionId),bound=a.version(group.bots.get(0).botVersionId);check(current!=null&&bound!=null);bot.spaceId=current.spaceId=bound.spaceId=group.spaceId="B";b.createBot(bot,current);if(!current.id.equals(bound.id))b.appendVersion(bound);b.createGroup(group);
            task.spaceId="B";task.version=10L;task.goal="SPACE_B_PRIVATE_TASK";new JdbcTaskStore(c,"B").create(task);task.id=only;task.taskNumber="TASK-9999";new JdbcTaskStore(c,"B").create(task);
            String now=GroupMemoryValues.date(b.now().toInstant());new JdbcGroupMemoryStore(c,"B").write(new Memory(memoryId,"B",groupId,1,"SPACE_B_PRIVATE_MEMORY","active",manual(),"owner","owner",now,now),null,0);c.commit();
        }
        GroupMemoryApplication app=new GroupMemoryApplication(source,new Policy(),TransactionObserver.NONE);ListedCheck.check(app.listGroupMemories(new TrustedContext("B","owner"),groupId));
        return JSON.createObjectNode().put("spaceBTaskId",only).put("sameGroupMemoryIdsScoped",true);
    }
    private static final class ListedCheck {static void check(GroupMemoryApplication.Listed value){GroupMemoryDatabaseProbe.check(value.revision==1&&value.memories.size()==1&&value.memories.get(0).text.equals("SPACE_B_PRIVATE_MEMORY")&&value.memories.get(0).spaceId.equals("B"));}}
    public static void main(String[] args){int exit=1;try{
        check(args.length==1&&Arrays.asList("seed-v5","verify-v5","faults","expire","facts","other-space").contains(args[0]));ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int value;(value=System.in.read())!=-1;){check(bytes.size()<131072);bytes.write(value);}JsonNode request=JSON.readTree(bytes.toByteArray());exact(request,"db","fixture");JsonNode fixture=request.get("fixture");check(fixture.isObject());LocalDatabaseConfig config=LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(request.get("db"))));
        try(HikariDataSource source=config.openPool()){DatabaseReadiness.requireConnection(source);ObjectNode result;if(args[0].equals("seed-v5")){exact(fixture);result=seedV5(source);}else{DatabaseReadiness.requireReady(source);switch(args[0]){case "verify-v5":result=verifyV5(source,fixture);break;case "faults":result=faults(source,fixture);break;case "expire":result=expire(source,fixture);break;case "other-space":result=otherSpace(source,fixture);break;default:exact(fixture);result=JSON.createObjectNode().put("factsSha256",facts(source,false));}}
            result.put("status","verified").put("case",args[0]);System.out.println(JSON.writeValueAsString(result));exit=0;
        }
    }catch(Exception failure){System.out.println("{\"status\":\"failed\",\"phase\":\""+phase+"\",\"category\":\"GROUP_MEMORY_PROBE\"}");}System.exit(exit);}
}
