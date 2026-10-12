package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariDataSource;
import java.io.*;
import java.security.*;
import java.sql.*;
import java.util.*;

/** Finite owner-checked disposable fixture main, never a production migration selector. */
public final class TaskDatabaseProbe {
    private static final ObjectMapper JSON = CompatibilityProbe.strictMapper();
    private static final ContractBoundary B = new ContractBoundary();
    private static final String[] TABLES = {"bots","bot_versions","bot_maintainers","groups","group_members","group_bots","command_scope","command_receipts","mutation_outbox","tasks","task_messages","task_space_head","task_event_cursors","desktop_runtime_nodes","group_runtime_grants","requirement_run_queue","requirement_run_results"};
    private static final String[] ORDER = {"space_id,id","space_id,id","space_id,bot_id,principal_id","space_id,id","space_id,group_id,principal_id","space_id,group_id,bot_id","space_id,principal_id","space_id,principal_id,command_id","space_id,id","space_id,id","space_id,id","space_id","space_id,id","space_id,id","space_id,group_id","space_id,id"};
    private static final String LEGACY_OUTBOX = "space_id,id,principal_id,command_id,operation,target_type,target_id,target_version,created_at";
    private static void check(boolean value) { if (!value) throw new IllegalStateException("TASK_FIXTURE"); }
    private static void exact(JsonNode n, String... names) { Set<String> actual = new HashSet<String>(); n.fieldNames().forEachRemaining(actual::add); check(n.isObject() && actual.equals(new HashSet<String>(Arrays.asList(names)))); }
    private static String id(JsonNode n, String key) { check(n.path(key).isTextual()); return B.validateParameter("getBot", "botId", n.path(key).textValue()); }
    private static ObjectNode facts(HikariDataSource source, boolean legacy) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256"); ObjectNode rows = JSON.createObjectNode();
        DataOutputStream out = new DataOutputStream(new DigestOutputStream(new OutputStream() { public void write(int b) {} }, digest));
        try (Connection c = source.getConnection()) {
            c.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ); c.setAutoCommit(false);
            for (int i = 0; i < (legacy ? 9 : TABLES.length); i++) {
                String table = TABLES[i]; out.writeUTF(table); int count = 0;
                String columns = legacy && table.equals("mutation_outbox") ? LEGACY_OUTBOX : "*";
                try (PreparedStatement p = c.prepareStatement("SELECT " + columns + " FROM " + table + " ORDER BY " + ORDER[i])) {
                    p.setQueryTimeout(2); try (ResultSet r = p.executeQuery()) {
                        ResultSetMetaData metadata = r.getMetaData(); out.writeInt(metadata.getColumnCount());
                        for (int j = 1; j <= metadata.getColumnCount(); j++) { out.writeUTF(metadata.getColumnName(j)); out.writeInt(metadata.getColumnType(j)); }
                        while (r.next()) { count++; out.writeBoolean(true); for (int j = 1; j <= metadata.getColumnCount(); j++) { byte[] value = r.getBytes(j); out.writeInt(value == null ? -1 : value.length); if (value != null) out.write(value); } }
                        out.writeBoolean(false);
                    }
                }
                rows.put(table, count);
            }
            c.rollback();
        }
        out.close(); StringBuilder hex = new StringBuilder(); for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT,"%02x",b & 255));
        return JSON.createObjectNode().put("status","verified").put("factsSha256",hex.toString()).put("tables", legacy ? 9 : TABLES.length).set("rows",rows);
    }
    private static ObjectNode v1(HikariDataSource source) throws Exception {
        check(MigrationRunner.configuration(source).target("1").load().migrate().migrationsExecuted == 1);
        IdentityPolicy policy = new IdentityPolicy() {
            public boolean activeMember(String s, String p) { return "A".equals(s) && Arrays.asList("p1","p2").contains(p); }
            public boolean mayCreateBot(TrustedContext a) { return true; } public boolean mayCreateGroup(TrustedContext a) { return true; }
            public boolean mayAssociate(TrustedContext a, Reference r, String id) { return false; } public boolean mayConfigure(TrustedContext a, Capability c) { return false; }
        };
        BotApplication app = new BotApplication(source, policy); TrustedContext actor = new TrustedContext("A","p1");
        CreateBotRequest bot = new CreateBotRequest(); bot.commandId="v1-bot"; bot.name="V1 retained"; bot.maintainerIds=Arrays.asList("p1","p2");
        bot.config=new BotConfig(); bot.config.description="V1"; bot.config.instructions="V1"; bot.config.knowledgeRefs=bot.config.repositoryRefs=bot.config.skillAllowlist=Collections.emptyList(); bot.config.capabilityCeiling=Collections.emptyList(); bot.config.memoryPolicy=BotConfigMemoryPolicy.DISABLED;
        ApplicationResponse response=app.execute(Operation.CREATE_BOT,actor,null,JdbcApplicationStore.json(bot));check(response.status==201); BotResult b=B.readResponse("createBot",201,response.body(),BotResult.class);
        CreateGroupRequest group=new CreateGroupRequest();group.commandId="v1-group";group.name="V1 Group";group.members=new ArrayList<GroupMember>();
        for(String principal:Arrays.asList("p1","p2")){GroupMember m=new GroupMember();m.principalId=principal;m.role=principal.equals("p1")?GroupMemberRole.ADMIN:GroupMemberRole.PARTICIPANT;group.members.add(m);}
        GroupBot gb=new GroupBot();gb.botId=b.bot.id;gb.botVersionId=b.botVersion.id;gb.role=GroupBotRole.SPECIALIST;group.bots=Collections.singletonList(gb);
        group.limits=new GroupLimits();group.limits.maxRuns=1L;group.limits.maxHandoffs=1L;group.limits.maxTokens=1L;
        response=app.execute(Operation.CREATE_GROUP,actor,null,JdbcApplicationStore.json(group));check(response.status==201);GroupResult g=B.readResponse("createGroup",201,response.body(),GroupResult.class);
        return JSON.createObjectNode().put("status","verified").put("bot",b.bot.id).put("botVersion",b.botVersion.id).put("group",g.group.id).put("migrations",1);
    }
    private static ObjectNode fixture(HikariDataSource source, String action, JsonNode n) throws Exception {
        String sql; Object[] values;
        if(action.equals("receipt")) {
            exact(n,"space","principal","command");
            try(Connection c=source.getConnection();PreparedStatement p=c.prepareStatement("SELECT target_id,http_status,body_bytes FROM command_receipts WHERE space_id=? AND principal_id=? AND command_id=? AND operation='createTask' AND target_type='task'")) {
                p.setString(1,id(n,"space"));p.setString(2,id(n,"principal"));p.setString(3,id(n,"command"));p.setQueryTimeout(2);
                try(ResultSet r=p.executeQuery()){check(r.next()&&r.getInt(2)==201);byte[] bytes=StorageCodec.boundedBody(r.getBytes(3));B.readResponse("createTask",201,bytes,TaskResult.class);ObjectNode result=JSON.createObjectNode().put("status","verified").put("target",r.getString(1)).put("body",Base64.getEncoder().encodeToString(bytes));check(!r.next());return result;}
            }
        }
        if(action.equals("expire-cursor")) {exact(n,"space","cursor");sql="UPDATE task_event_cursors SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 25 HOUR),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 HOUR) WHERE space_id=? AND id=?";values=new Object[]{id(n,"space"),id(n,"cursor")};}
        else if(action.equals("expire-command")){exact(n,"space","principal","command");sql="UPDATE command_receipts SET created_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 8 DAY),expires_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 1 DAY) WHERE space_id=? AND principal_id=? AND command_id=?";values=new Object[]{id(n,"space"),id(n,"principal"),id(n,"command")};}
        else throw new IllegalStateException("TASK_FIXTURE");
        try(Connection c=source.getConnection();PreparedStatement p=c.prepareStatement(sql)){c.setAutoCommit(false);p.setQueryTimeout(2);for(int i=0;i<values.length;i++)p.setObject(i+1,values[i]);check(p.executeUpdate()==1);c.commit();}
        return JSON.createObjectNode().put("status","verified").put("fixture",action);
    }
    public static void main(String[] args) {
        int exit=1;
        try {
            check(args.length==1&&Arrays.asList("facts","legacy","v1","expire-cursor","expire-command","receipt").contains(args[0]));
            ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(int b;(b=System.in.read())!=-1;){check(bytes.size()<65536);bytes.write(b);}
            JsonNode root=JSON.readTree(bytes.toByteArray());exact(root,"db","fixture");
            LocalDatabaseConfig config=LocalDatabaseConfig.fromTrustedLauncher(new ByteArrayInputStream(JSON.writeValueAsBytes(root.get("db"))));
            try(HikariDataSource source=config.openPool()){
                DatabaseReadiness.requireConnection(source);String action=args[0];
                if(!action.equals("v1")&&!action.equals("legacy"))DatabaseReadiness.requireReady(source);
                ObjectNode result=action.equals("v1")?v1(source):action.equals("facts")||action.equals("legacy")?facts(source,action.equals("legacy")):fixture(source,action,root.get("fixture"));
                System.out.println(result);exit=0;
            }
        }catch(Exception failure){System.out.println("{\"status\":\"failed\",\"category\":\"B02_SQL_FIXTURE\"}");}
        System.exit(exit);
    }
}
