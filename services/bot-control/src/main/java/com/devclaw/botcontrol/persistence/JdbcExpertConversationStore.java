package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.sql.*;
import java.util.*;

/** Internal storage only. Caller owns scope -> space head -> Group -> Task locks. */
public final class JdbcExpertConversationStore {
    private final Connection connection;
    private final String space;
    public JdbcExpertConversationStore(Connection connection,String space){this.connection=connection;this.space=space;}
    private PreparedStatement prepare(String sql,Object... values)throws SQLException {
        PreparedStatement p=connection.prepareStatement(sql);p.setQueryTimeout(2);
        try{for(int i=0;i<values.length;i++)if(values[i] instanceof byte[])p.setBytes(i+1,(byte[])values[i]);else p.setObject(i+1,values[i]);return p;}
        catch(SQLException failure){p.close();throw failure;}
    }
    private void change(String sql,Object... values)throws SQLException {try(PreparedStatement p=prepare(sql,values)){if(p.executeUpdate()!=1)throw JdbcApplicationStore.corrupt();}}
    private static byte[] bytes(JsonNode value){return JdbcApplicationStore.json(value);}
    private static ObjectNode object(byte[] bytes){try{JsonNode value=CompatibilityProbe.strictMapper().readTree(bytes);if(!value.isObject())throw JdbcApplicationStore.corrupt();return (ObjectNode)value;}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    public String instanceId()throws SQLException {
        try(PreparedStatement p=prepare("SELECT instance_id FROM expert_service_identity WHERE singleton=1");ResultSet r=p.executeQuery()){
            if(!r.next())throw JdbcApplicationStore.corrupt();String id=GroupId.id(r.getString(1));if(r.next())throw JdbcApplicationStore.corrupt();return id;
        }
    }
    private static final class GroupId {static String id(String value){try{return com.devclaw.botcontrol.application.GroupMemoryValues.id(value);}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}}}
    public static final class Conversation {
        public final String taskId,groupId,botId,principalId,role;
        public final JsonNode carried;
        Conversation(ResultSet r)throws SQLException {this(r,true);}
        Conversation(ResultSet r,boolean includeCarried)throws SQLException {
            taskId=GroupId.id(r.getString("task_id"));groupId=GroupId.id(r.getString("group_id"));botId=GroupId.id(r.getString("bot_id"));principalId=GroupId.id(r.getString("principal_id"));role=r.getString("role");
            if(!Arrays.asList("main","task").contains(role)||!Objects.equals(r.getString("main_key"),"main".equals(role)?principalId:null))throw JdbcApplicationStore.corrupt();
            try{carried=includeCarried?CompatibilityProbe.strictMapper().readTree(r.getBytes("carried_context")):CompatibilityProbe.strictMapper().createArrayNode();if(!carried.isArray())throw JdbcApplicationStore.corrupt();}catch(Exception failure){throw JdbcApplicationStore.corrupt();}
        }
    }
    public Conversation conversation(String taskId)throws SQLException {
        try(PreparedStatement p=prepare("SELECT * FROM expert_task_conversations WHERE space_id=? AND task_id=?",space,taskId);ResultSet r=p.executeQuery()){
            if(!r.next())return null;Conversation value=new Conversation(r);if(!space.equals(r.getString("space_id"))||!taskId.equals(value.taskId)||r.next())throw JdbcApplicationStore.corrupt();return value;
        }
    }
    public Map<String,Conversation> conversations(List<String> tasks)throws SQLException {
        Map<String,Conversation> values=new HashMap<String,Conversation>();if(tasks.isEmpty())return values;if(tasks.size()>40)throw new com.devclaw.botcontrol.domain.ApplicationFault(ErrorCode.INVALID_PAYLOAD);
        List<Object> args=new ArrayList<Object>();args.add(space);args.addAll(tasks);String marks=String.join(",",Collections.nCopies(tasks.size(),"?"));
        try(PreparedStatement p=prepare("SELECT space_id,task_id,group_id,bot_id,principal_id,role,main_key FROM expert_task_conversations WHERE space_id=? AND task_id IN ("+marks+") ORDER BY task_id",args.toArray());ResultSet r=p.executeQuery()){
            while(r.next()){Conversation value=new Conversation(r,false);if(!space.equals(r.getString("space_id"))||!tasks.contains(value.taskId)||values.put(value.taskId,value)!=null)throw JdbcApplicationStore.corrupt();}
        }return values;
    }
    public Set<String> busy(List<String> tasks)throws SQLException {
        Set<String> values=new HashSet<String>();if(tasks.isEmpty())return values;List<Object> args=new ArrayList<Object>();args.add(space);args.addAll(tasks);String marks=String.join(",",Collections.nCopies(tasks.size(),"?"));
        try(PreparedStatement p=prepare("SELECT DISTINCT task_id FROM requirement_run_queue WHERE space_id=? AND task_id IN ("+marks+") AND status NOT IN ('succeeded','failed','cancelled')",args.toArray());ResultSet r=p.executeQuery()){while(r.next())values.add(GroupId.id(r.getString(1)));}return values;
    }
    public String main(String group,String bot,String principal)throws SQLException {
        try(PreparedStatement p=prepare("SELECT task_id FROM expert_task_conversations WHERE space_id=? AND group_id=? AND bot_id=? AND main_key=?",space,group,bot,principal);ResultSet r=p.executeQuery()){
            if(!r.next())return null;String id=GroupId.id(r.getString(1));if(r.next())throw JdbcApplicationStore.corrupt();return id;
        }
    }
    public void conversation(String task,String group,String bot,String principal,String role,JsonNode carried)throws SQLException {
        change("INSERT INTO expert_task_conversations(space_id,task_id,group_id,bot_id,principal_id,role,main_key,carried_context) VALUES(?,?,?,?,?,?,?,?)",space,task,group,bot,principal,role,"main".equals(role)?principal:null,bytes(carried));
    }
    public static final class Input {
        public final String taskId,runId,profile,digest,principalId,commandId;
        public final long taskVersion;
        public final byte[] fingerprint;
        public final ObjectNode body;
        Input(ResultSet r)throws SQLException {
            taskId=GroupId.id(r.getString("task_id"));runId=r.getString("run_id");principalId=GroupId.id(r.getString("principal_id"));commandId=GroupId.id(r.getString("command_id"));profile=r.getString("profile");digest=r.getString("digest");taskVersion=r.getLong("task_version");fingerprint=r.getBytes("fingerprint");body=object(r.getBytes("body_bytes"));if(runId!=null)GroupId.id(runId);
            if(!Arrays.asList("expert_main_v1","expert_task_v1").contains(profile)||digest==null||!digest.matches("sha256:[a-f0-9]{64}")||taskVersion<1||taskVersion>JdbcTaskStore.MAX||!taskId.equals(body.path("taskId").textValue())||taskVersion!=body.path("taskVersion").longValue()||!profile.equals(body.path("profile").textValue())||!digest.equals(body.path("digest").textValue())||fingerprint==null||fingerprint.length!=32)throw JdbcApplicationStore.corrupt();
        }
    }
    private Input inputWhere(String where,Object... values)throws SQLException {
        try(PreparedStatement p=prepare("SELECT * FROM expert_conversation_inputs WHERE space_id=? AND "+where,values);ResultSet r=p.executeQuery()){
            if(!r.next())return null;Input input=new Input(r);if(!space.equals(r.getString("space_id"))||r.next())throw JdbcApplicationStore.corrupt();return input;
        }
    }
    public Input input(String principal,String command)throws SQLException{return inputWhere("principal_id=? AND command_id=?",space,principal,command);}
    public Input runInput(String run)throws SQLException{return inputWhere("run_id=?",space,run);}
    public void input(String principal,String command,byte[] fingerprint,ObjectNode body)throws SQLException {
        change("INSERT INTO expert_conversation_inputs(space_id,principal_id,command_id,task_id,task_version,profile,digest,fingerprint,body_bytes) VALUES(?,?,?,?,?,?,?,?,?)",space,principal,command,body.path("taskId").textValue(),body.path("taskVersion").longValue(),body.path("profile").textValue(),body.path("digest").textValue(),fingerprint,bytes(body));
    }
    public void attach(String principal,String command,JdbcRequirementRunStore.Run run,Input input)throws SQLException {
        change("UPDATE expert_conversation_inputs SET run_id=? WHERE space_id=? AND principal_id=? AND command_id=? AND run_id IS NULL",run.id,space,principal,command);
        change("UPDATE requirement_run_queue SET execution_profile=?,context_digest=? WHERE space_id=? AND id=? AND execution_profile IS NULL AND context_digest IS NULL",input.profile,input.digest,space,run.id);
    }
    public static final class Command {
        public final String taskId,sourceRunId,operation;
        public final byte[] fingerprint;
        public final ObjectNode receipt;
        Command(ResultSet r)throws SQLException {
            taskId=r.getString("task_id");sourceRunId=r.getString("source_run_id");operation=r.getString("operation");fingerprint=r.getBytes("fingerprint");receipt=object(r.getBytes("receipt_bytes"));
            JsonNode task=receipt.path("task");if(!taskId.equals(task.path("id").textValue())||!r.getString("space_id").equals(task.path("spaceId").textValue())||!r.getString("principal_id").equals(receipt.path("principalId").textValue())||!Objects.equals(sourceRunId,receipt.path("sourceRunId").textValue())||fingerprint==null||fingerprint.length!=32)throw JdbcApplicationStore.corrupt();
        }
    }
    private Command commandWhere(String where,Object... values)throws SQLException {
        try(PreparedStatement p=prepare("SELECT * FROM expert_conversation_commands WHERE space_id=? AND "+where,values);ResultSet r=p.executeQuery()){
            if(!r.next())return null;Command command=new Command(r);if(!space.equals(r.getString("space_id"))||r.next())throw JdbcApplicationStore.corrupt();return command;
        }
    }
    public Command command(String principal,String command)throws SQLException{return commandWhere("principal_id=? AND command_id=?",space,principal,command);}
    public Command source(String run)throws SQLException{return commandWhere("source_run_id=?",space,run);}
    public void command(String principal,String command,String operation,byte[] fingerprint,ObjectNode receipt)throws SQLException {
        change("INSERT INTO expert_conversation_commands(space_id,principal_id,command_id,task_id,source_run_id,operation,fingerprint,receipt_bytes) VALUES(?,?,?,?,?,?,?,?)",space,principal,command,receipt.path("task").path("id").textValue(),receipt.path("sourceRunId").textValue(),operation,fingerprint,bytes(receipt));
    }
    public List<TaskMessageResult> messages(String task,long version,String bot)throws SQLException {
        List<TaskMessageResult> values=new ArrayList<TaskMessageResult>();
        try(PreparedStatement p=prepare("SELECT id,task_version,author_principal_id,body_bytes FROM task_messages WHERE space_id=? AND task_id=? AND task_version<=? AND (target_bot_id IS NULL OR target_bot_id=?) ORDER BY task_version LIMIT 201",space,task,version,bot);ResultSet r=p.executeQuery()){
            while(r.next()){
                TaskMessageResult value;try{value=new ContractBoundary().readResponse("createTaskMessage",201,r.getBytes(4),TaskMessageResult.class);}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}
                if(!space.equals(value.message.spaceId)||!task.equals(value.message.taskId)||!r.getString(1).equals(value.message.id)||r.getLong(2)!=value.taskVersion||!r.getString(3).equals(value.message.authorPrincipalId))throw JdbcApplicationStore.corrupt();values.add(value);
            }
        }
        if(values.size()>200)throw new com.devclaw.botcontrol.domain.ApplicationFault(ErrorCode.PAYLOAD_TOO_LARGE);return values;
    }
    public Map<String,String> originalRequesters(String group,List<String> ids,String bot)throws SQLException {
        Map<String,String> values=new HashMap<String,String>();if(ids.isEmpty())return values;if(ids.size()>40)throw JdbcApplicationStore.corrupt();
        List<Object> args=new ArrayList<Object>();args.add(space);args.add(group);args.addAll(ids);String marks=String.join(",",Collections.nCopies(ids.size(),"?"));
        try(PreparedStatement p=prepare("SELECT t.id,q.bot_id,q.requester_principal_id FROM tasks t LEFT JOIN requirement_run_queue q ON q.space_id=t.space_id AND q.id=(SELECT r.id FROM requirement_run_queue r WHERE r.space_id=t.space_id AND r.task_id=t.id ORDER BY r.created_at,r.id LIMIT 1) WHERE t.space_id=? AND t.group_id=? AND t.id IN ("+marks+")",args.toArray());ResultSet r=p.executeQuery()){
            while(r.next())if(bot.equals(r.getString("bot_id")))values.put(GroupId.id(r.getString("id")),GroupId.id(r.getString("requester_principal_id")));
        }return values;
    }
    public String originalRequester(String task,String bot)throws SQLException {
        try(PreparedStatement p=prepare("SELECT requester_principal_id,bot_id FROM requirement_run_queue WHERE space_id=? AND task_id=? ORDER BY created_at,id LIMIT 1",space,task);ResultSet r=p.executeQuery()){
            if(!r.next())return null;return bot.equals(r.getString(2))?GroupId.id(r.getString(1)):null;
        }
    }
}
