package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.application.RuntimeNodeApplication.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcRuntimeNodeStore.*;
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

/** Finite disposable JDBC probe. Fixed actions only; no production seam. */
public final class RuntimeNodeDatabaseProbe {
    private static final ObjectMapper JSON = CompatibilityProbe.strictMapper();
    private static final ContractBoundary B = new ContractBoundary();
    private static final TrustedContext OWNER = new TrustedContext("A","owner"), BUSINESS = new TrustedContext("A","business"), OTHER = new TrustedContext("A","other");
    private static final TrustedNodeContext NODE = new TrustedNodeContext("A","node","owner");
    private static final Set<Capability> CAPS = Collections.singleton(Capability.REQUIREMENTS_ANALYZE);
    private static String phase = "input";
    private static int denials;
    private static void check(boolean value) { if (!value) throw new IllegalStateException("NODE_PROBE_ASSERTION"); }
    private static void exact(JsonNode n, String... keys) { Set<String> names=new HashSet<String>();n.fieldNames().forEachRemaining(names::add);check(n.isObject()&&names.equals(new HashSet<String>(Arrays.asList(keys)))); }
    private static String id(JsonNode n,String key) { check(n.path(key).isTextual());return B.validateParameter("getBot","botId",n.path(key).textValue()); }
    private static final class Policy implements IdentityPolicy, RuntimeAccessPolicy {
        final Set<String> denied = new HashSet<String>();
        public boolean activeMember(String s,String p) { return Arrays.asList("A","B").contains(s)&&Arrays.asList("owner","business","other","outsider").contains(p)&&!denied.contains("member:"+p); }
        public boolean mayCreateBot(TrustedContext a) { return true; } public boolean mayCreateGroup(TrustedContext a) { return true; }
        public boolean mayAssociate(TrustedContext a,Reference kind,String ref) { return false; }
        public boolean mayConfigure(TrustedContext a,Capability cap) { return true; }
        public boolean mayUseCapability(TrustedContext a,Capability cap) { return cap==Capability.REQUIREMENTS_ANALYZE&&!denied.contains("cap:"+a.principalId); }
        public boolean mayUseWorkspace(TrustedContext a,String ref) { return ref.equals("view")&&!denied.contains("workspace:"+a.principalId); }
    }
    private static RuntimeNodeApplication app(HikariDataSource s,Policy p) { return new RuntimeNodeApplication(s,p,p,TransactionObserver.NONE); }
    private static Instant expiry() { return Instant.ofEpochMilli(System.currentTimeMillis()+3600000); }
    private static void denied(ErrorCode code,Runnable work) {
        try { work.run();throw new IllegalStateException("MISSING_DENIAL"); }
        catch(ApplicationFault failure) {
            if(failure.code!=code)throw new IllegalStateException("EXPECTED_"+code.wire()+"_ACTUAL_"+failure.code.wire());
            check(failure.getCause()==null&&failure.getMessage().equals(code.wire()));denials++;
        }
    }
    private static ObjectNode seed(HikariDataSource source,Policy policy) {
        BotApplication bots=new BotApplication(source,policy);
        BotConfig config=new BotConfig();config.description="Requirement expert";config.instructions="Analyze only";config.knowledgeRefs=config.repositoryRefs=config.skillAllowlist=Collections.emptyList();config.capabilityCeiling=new ArrayList<Capability>(CAPS);config.memoryPolicy=BotConfigMemoryPolicy.DISABLED;
        CreateBotRequest r=new CreateBotRequest();r.commandId="seed-bot";r.name="Expert";r.maintainerIds=Arrays.asList("owner","other");r.config=config;
        ApplicationResponse response=bots.execute(Operation.CREATE_BOT,OWNER,null,JdbcApplicationStore.json(r));check(response.status==201);BotResult b=B.readResponse("createBot",201,response.body(),BotResult.class);
        CreateGroupRequest g=new CreateGroupRequest();g.commandId="seed-group";g.name="Team";g.members=new ArrayList<GroupMember>();
        for(String p:Arrays.asList("owner","business","other")){GroupMember m=new GroupMember();m.principalId=p;m.role=p.equals("business")?GroupMemberRole.PARTICIPANT:GroupMemberRole.ADMIN;g.members.add(m);}
        GroupBot gb=new GroupBot();gb.botId=b.bot.id;gb.botVersionId=b.botVersion.id;gb.role=GroupBotRole.SPECIALIST;g.bots=Collections.singletonList(gb);
        g.limits=new GroupLimits();g.limits.maxRuns=1L;g.limits.maxHandoffs=1L;g.limits.maxTokens=1000L;
        response=bots.execute(Operation.CREATE_GROUP,OWNER,null,JdbcApplicationStore.json(g));check(response.status==201);GroupResult group=B.readResponse("createGroup",201,response.body(),GroupResult.class);
        CreateTaskRequest t=new CreateTaskRequest();t.commandId="seed-task";t.groupId=group.group.id;t.title="Requirement 中文";t.goal="Scope clarification";t.inputArtifactVersions=Collections.emptyList();
        response=new TaskApplication(source,policy,TransactionObserver.NONE).execute(Operation.CREATE_TASK,BUSINESS,null,null,null,JdbcApplicationStore.json(t));check(response.status==201);TaskResult task=B.readResponse("createTask",201,response.body(),TaskResult.class);
        return JSON.createObjectNode().put("bot",b.bot.id).put("botVersion",b.botVersion.id).put("group",group.group.id).put("task",task.task.id);
    }
    // All thirteen V2 tables plus the V1/V2 history rows, deterministic exact bytes.
    private static String v2Facts(HikariDataSource source) throws Exception {
        String[] tables={"bots","bot_versions","bot_maintainers","groups","group_members","group_bots","command_scope","command_receipts","mutation_outbox","tasks","task_messages","task_space_head","task_event_cursors","bot_schema_history"};
        String[] order={"space_id,id","space_id,id","space_id,bot_id,principal_id","space_id,id","space_id,group_id,principal_id","space_id,group_id,bot_id","space_id,principal_id","space_id,principal_id,command_id","space_id,id","space_id,id","space_id,id","space_id","space_id,id","installed_rank"};
        MessageDigest digest=MessageDigest.getInstance("SHA-256");
        try(DataOutputStream out=new DataOutputStream(new DigestOutputStream(new OutputStream(){public void write(int b){}},digest));Connection c=source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);c.setAutoCommit(false);
            for(int i=0;i<tables.length;i++)try(PreparedStatement p=c.prepareStatement("SELECT * FROM "+tables[i]+(i==13?" WHERE version IN ('1','2')":"")+" ORDER BY "+order[i])) {
                p.setQueryTimeout(2);out.writeUTF(tables[i]);try(ResultSet r=p.executeQuery()){out.writeInt(r.getMetaData().getColumnCount());while(r.next()){out.writeBoolean(true);for(int j=1;j<=r.getMetaData().getColumnCount();j++){byte[] bytes=r.getBytes(j);out.writeInt(bytes==null?-1:bytes.length);if(bytes!=null)out.write(bytes);}}out.writeBoolean(false);}
            } c.rollback();
        }
        StringBuilder hex=new StringBuilder();for(byte b:digest.digest())hex.append(String.format(Locale.ROOT,"%02x",b&255));return hex.toString();
    }
    private static Grant grant(HikariDataSource source,String group) throws Exception {try(Connection c=source.getConnection()){c.setAutoCommit(false);Grant g=new JdbcRuntimeNodeStore(c,"A").grant(group);c.rollback();return g;}}
    private static Node node(HikariDataSource source) throws Exception {try(Connection c=source.getConnection()){c.setAutoCommit(false);Node n=new JdbcRuntimeNodeStore(c,"A").node("node");c.rollback();return n;}}
    private static void sql(HikariDataSource source,String sql,Object... values) throws Exception {
        try(Connection c=source.getConnection();PreparedStatement p=c.prepareStatement(sql)){c.setAutoCommit(false);p.setQueryTimeout(2);for(int i=0;i<values.length;i++){Object v=values[i];if(v instanceof byte[])p.setBytes(i+1,(byte[])v);else if(v instanceof Instant)p.setTimestamp(i+1,Timestamp.from((Instant)v),Calendar.getInstance(TimeZone.getTimeZone("UTC")));else p.setObject(i+1,v);}check(p.executeUpdate()==1);c.commit();}
    }
    private static RequirementDispatch ready(RuntimeNodeApplication app,String task,String bot,String pin) {RequirementDispatch d=app.resolveRequirementDispatch(BUSINESS,task,bot);check(d.status==DispatchStatus.READY&&d.botVersionId.equals(pin)&&d.nodeId.equals("node")&&d.ownerPrincipalId.equals("owner")&&d.capability==Capability.REQUIREMENTS_ANALYZE&&d.readOnly&&d.validUntil.isAfter(d.observedAt));return d;}
    private static void members(HikariDataSource s,Policy p,String group,boolean ownerAdmin,boolean business) throws Exception {
        Group old;try(Connection c=s.getConnection()){c.setAutoCommit(false);old=new JdbcApplicationStore(c,"A",TransactionObserver.NONE).group(group);c.rollback();}
        UpdateGroupMembersRequest r=new UpdateGroupMembersRequest();r.commandId=UUID.randomUUID().toString();r.expectedVersion=old.version;r.members=new ArrayList<GroupMember>();r.bots=old.bots;
        for(String principal:Arrays.asList("owner","business","other")){if(principal.equals("business")&&!business)continue;GroupMember m=new GroupMember();m.principalId=principal;m.role=principal.equals("other")||principal.equals("owner")&&ownerAdmin?GroupMemberRole.ADMIN:GroupMemberRole.PARTICIPANT;r.members.add(m);}
        check(new BotApplication(s,p).execute(Operation.UPDATE_GROUP_MEMBERS,OTHER,group,JdbcApplicationStore.json(r)).status==200);
    }
    private static ObjectNode exercise(HikariDataSource s,Policy p,ObjectNode fixture) throws Exception {
        phase="seed";if(fixture.size()==0)fixture=seed(s,p);else {check(fixture.path("v2Facts").asText().equals(v2Facts(s)));fixture.remove("v2Facts");fixture.remove("migrations");}
        final String group=id(fixture,"group"),task=id(fixture,"task"),bot=id(fixture,"bot"),pin=id(fixture,"botVersion");RuntimeNodeApplication app=app(s,p);
        phase="node-owner";Node first=app.observeDesktopNode(NODE,true,CAPS);check(first.version==1&&first.ownerPrincipalId.equals("owner"));
        Node heartbeat=app.observeDesktopNode(NODE,true,CAPS);check(heartbeat.version==1&&!heartbeat.lastSeenAt.isBefore(first.lastSeenAt));
        denied(ErrorCode.FORBIDDEN,()->app.observeDesktopNode(new TrustedNodeContext("A","node","other"),true,CAPS));check(node(s).ownerPrincipalId.equals("owner"));
        app.observeDesktopNode(new TrustedNodeContext("A","other-node","other"),true,CAPS);
        phase="grant-denials";
        denied(ErrorCode.FORBIDDEN,()->app.authorizeRequirementNode(BUSINESS,group,"node","view",0,expiry()));
        denied(ErrorCode.FORBIDDEN,()->app.authorizeRequirementNode(OTHER,group,"node","view",0,expiry()));
        denied(ErrorCode.NOT_FOUND,()->app.authorizeRequirementNode(new TrustedContext("B","owner"),group,"node","view",0,expiry()));
        denied(ErrorCode.FORBIDDEN,()->app.authorizeRequirementNode(OWNER,group,"node","missing-view",0,expiry()));
        denied(ErrorCode.INVALID_PAYLOAD,()->app.authorizeRequirementNode(OWNER,group,"node","view",0,Instant.EPOCH));
        denied(ErrorCode.INVALID_PAYLOAD,()->app.authorizeRequirementNode(OWNER,group,"node","view",0,Instant.ofEpochMilli(System.currentTimeMillis()+RuntimeNodeApplication.MAX_GRANT_MILLIS+60000)));
        denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));check(grant(s,group)==null);
        Grant g=app.authorizeRequirementNode(OWNER,group,"node","view",0,expiry());check(g.version==1&&g.enabled);ready(app,task,bot,pin);
        denied(ErrorCode.VERSION_CONFLICT,()->app.authorizeRequirementNode(OWNER,group,"node","view",0,expiry()));
        phase="current-acl";
        denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(new TrustedContext("A","outsider"),task,bot));
        denied(ErrorCode.NOT_FOUND,()->app.resolveRequirementDispatch(new TrustedContext("B","business"),task,bot));
        denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,"other-bot"));
        for(String key:Arrays.asList("cap:business","cap:owner","workspace:business","workspace:owner","member:owner","member:business")){p.denied.add(key);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));p.denied.remove(key);}ready(app,task,bot,pin);
        members(s,p,group,true,false);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));members(s,p,group,true,true);
        members(s,p,group,false,true);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));members(s,p,group,true,true);
        phase="fixed-expert";
        CreateBotVersionRequest vr=new CreateBotVersionRequest();vr.commandId="new-unbound-version";vr.expectedVersion=1L;
        try(Connection c=s.getConnection()){c.setAutoCommit(false);vr.config=new JdbcApplicationStore(c,"A",TransactionObserver.NONE).version(pin).config;c.rollback();}vr.config.capabilityCeiling=Collections.emptyList();
        check(new BotApplication(s,p).execute(Operation.CREATE_BOT_VERSION,OWNER,bot,JdbcApplicationStore.json(vr)).status==201);ready(app,task,bot,pin);
        sql(s,"UPDATE bots SET status='disabled' WHERE space_id='A' AND id=?",bot);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));sql(s,"UPDATE bots SET status='active' WHERE space_id='A' AND id=?",bot);
        phase="phase-boundary";
        Task current;try(Connection c=s.getConnection()){c.setAutoCommit(false);current=new JdbcTaskStore(c,"A").task(task);c.rollback();}
        TaskResult tr=new TaskResult();tr.task=current;byte[] original=B.writeResponse("createTask",201,tr);
        current.stages.get(0).status=StageStatus.COMPLETED;current.stages.get(1).status=StageStatus.ACTIVE;current.currentStageId=current.stages.get(1).id;
        // B02's store only supports the initial requirement state. An injected
        // later stage is corrupt storage, not a supported product transition.
        sql(s,"UPDATE tasks SET body_bytes=? WHERE space_id='A' AND id=?",B.writeResponse("createTask",201,tr),task);denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->app.resolveRequirementDispatch(BUSINESS,task,bot));sql(s,"UPDATE tasks SET body_bytes=? WHERE space_id='A' AND id=?",original,task);
        phase="capability-and-offline";check(app.observeDesktopNode(NODE,false,CAPS).version==2);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));
        check(app.observeDesktopNode(NODE,true,Collections.emptySet()).version==3);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));check(app.observeDesktopNode(NODE,true,CAPS).version==4);
        Node fresh=node(s);sql(s,"UPDATE desktop_runtime_nodes SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY),last_seen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 61 SECOND) WHERE space_id='A' AND id='node'");
        RequirementDispatch wait=app.resolveRequirementDispatch(BUSINESS,task,bot);check(wait.status==DispatchStatus.WAITING_NODE&&wait.nodeId.equals("node")&&wait.grantVersion==1); // other-node is online: never fallback
        sql(s,"UPDATE desktop_runtime_nodes SET created_at=?,last_seen_at=? WHERE space_id='A' AND id='node'",fresh.createdAt,fresh.lastSeenAt);app.observeDesktopNode(NODE,true,CAPS);ready(app,task,bot,pin);
        phase="expiry-revoke";Grant before=grant(s,group);sql(s,"UPDATE group_runtime_grants SET expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 SECOND) WHERE space_id='A' AND group_id=?",group);
        denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));sql(s,"UPDATE group_runtime_grants SET expires_at=? WHERE space_id='A' AND group_id=?",before.expiresAt,group);
        denied(ErrorCode.FORBIDDEN,()->app.revokeRequirementNode(BUSINESS,group,1));check(app.revokeRequirementNode(OTHER,group,1).version==2);
        app.observeDesktopNode(NODE,true,CAPS);denied(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(BUSINESS,task,bot));
        denied(ErrorCode.VERSION_CONFLICT,()->app.authorizeRequirementNode(OWNER,group,"node","view",1,expiry()));check(app.authorizeRequirementNode(OWNER,group,"node","view",2,expiry()).version==3);
        phase="rollback-unknown";Grant stable=grant(s,group);
        RuntimeNodeApplication rollback=new RuntimeNodeApplication(s,p,p,stage->{if(stage==TransactionObserver.Stage.BEFORE_COMMIT)throw new IllegalStateException("DO_NOT_EXPOSE");});
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.authorizeRequirementNode(OWNER,group,"node","view",3,expiry()));Grant after=grant(s,group);check(after.version==stable.version&&after.updatedAt.equals(stable.updatedAt)&&after.expiresAt.equals(stable.expiresAt));
        denied(ErrorCode.DEPENDENCY_UNAVAILABLE,()->rollback.observeDesktopNode(new TrustedNodeContext("A","rollback-node","owner"),true,CAPS));
        try(Connection c=s.getConnection()){c.setAutoCommit(false);check(new JdbcRuntimeNodeStore(c,"A").node("rollback-node")==null);c.rollback();}
        RuntimeNodeApplication lost=new RuntimeNodeApplication(s,p,p,stage->{if(stage==TransactionObserver.Stage.AFTER_COMMIT)throw new IllegalStateException("DO_NOT_EXPOSE");});
        denied(ErrorCode.OUTCOME_UNKNOWN,()->lost.authorizeRequirementNode(OWNER,group,"node","view",3,expiry()));Grant committed=grant(s,group);check(committed.version==4&&committed.enabled&&committed.id.equals(stable.id));
        denied(ErrorCode.VERSION_CONFLICT,()->app.authorizeRequirementNode(OWNER,group,"node","view",3,expiry()));RequirementDispatch decision=ready(app,task,bot,pin);check(decision.grantVersion==4&&decision.nodeVersion==4);
        return fixture.put("grantVersion",4).put("nodeVersion",4).put("denials",denials);
    }
    public static void main(String[] args) {
        int exit=1;
        try {
            check(args.length==1&&Arrays.asList("seed-v2","exercise","cas","reopen").contains(args[0]));
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int b;(b=System.in.read())!=-1;){check(bytes.size()<65536);bytes.write(b);}JsonNode input=JSON.readTree(bytes.toByteArray());exact(input,"db","fixture");check(input.path("fixture").isObject());
            LocalDatabaseConfig config=LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(input.get("db"))));
            try(HikariDataSource s=config.openPool()) {
                DatabaseReadiness.requireConnection(s);Policy p=new Policy();ObjectNode fixture=(ObjectNode)input.get("fixture");ObjectNode proof;
                if(args[0].equals("seed-v2")){phase="seed-v2";check(fixture.size()==0);check(MigrationRunner.configuration(s).target("2").load().migrate().migrationsExecuted==2);proof=seed(s,p).put("v2Facts",v2Facts(s)).put("migrations",2);}
                else {
                    DatabaseReadiness.requireReady(s);
                    if(args[0].equals("exercise"))proof=exercise(s,p,fixture);
                    else {
                        phase=args[0];exact(fixture,"bot","botVersion","group","task","grantVersion","nodeVersion","denials");String group=id(fixture,"group"),task=id(fixture,"task"),bot=id(fixture,"bot"),pin=id(fixture,"botVersion");check(fixture.path("grantVersion").isIntegralNumber()&&fixture.path("nodeVersion").isIntegralNumber());long version=fixture.path("grantVersion").longValue();RuntimeNodeApplication app=app(s,p);
                        if(args[0].equals("cas")) {
                            boolean winner=true;try{Grant g=app.authorizeRequirementNode(OWNER,group,"node","view",version,expiry());check(g.version==version+1);}catch(ApplicationFault f){check(f.code==ErrorCode.VERSION_CONFLICT&&f.currentVersion!=null&&f.currentVersion==version+1);winner=false;}
                            proof=JSON.createObjectNode().put("winner",winner).put("grantVersion",version+1);
                        }else {app.observeDesktopNode(NODE,true,CAPS);RequirementDispatch d=ready(app,task,bot,pin);check(d.grantVersion==version&&d.nodeVersion==fixture.path("nodeVersion").longValue());proof=JSON.createObjectNode().put("restored",true).put("grantVersion",d.grantVersion).put("nodeVersion",d.nodeVersion);}
                    }
                }
                proof.put("status","verified").put("case",args[0]);System.out.println(proof);exit=0;
            }
        }catch(Exception failure){String code=failure instanceof ApplicationFault?((ApplicationFault)failure).code.wire():failure instanceof DatabaseFailure?((DatabaseFailure)failure).category().name():failure.getMessage()!=null&&failure.getMessage().matches("EXPECTED_[A-Z_]+_ACTUAL_[A-Z_]+")?failure.getMessage():"NODE_PROBE_ASSERTION";System.out.println("{\"status\":\"failed\",\"phase\":\""+phase+"\",\"category\":\""+code+"\"}");}
        System.exit(exit);
    }
}
