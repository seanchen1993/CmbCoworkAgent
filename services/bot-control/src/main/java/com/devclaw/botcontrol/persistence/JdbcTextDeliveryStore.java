package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.sql.*;
import java.util.*;

/** Internal text records, never public Artifact/Approval DTOs. Caller holds the Group and Task locks. */
public final class JdbcTextDeliveryStore {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private final Connection c; private final String space;
    public JdbcTextDeliveryStore(Connection c,String space){this.c=c;this.space=space;}
    private PreparedStatement prepare(String sql,Object... args)throws SQLException {
        PreparedStatement p=c.prepareStatement(sql);p.setQueryTimeout(2);
        try{for(int i=0;i<args.length;i++)if(args[i] instanceof byte[])p.setBytes(i+1,(byte[])args[i]);else p.setObject(i+1,args[i]);return p;}
        catch(SQLException failure){p.close();throw failure;}
    }
    private static byte[] bytes(JsonNode n){try{return JSON.writeValueAsBytes(n);}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private static ObjectNode value(byte[] bytes){try{JsonNode n=JSON.readTree(bytes);if(!n.isObject())throw JdbcApplicationStore.corrupt();return (ObjectNode)n;}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private static ObjectNode associated(ResultSet row)throws SQLException {
        ObjectNode n=value(row.getBytes(1));ResultSetMetaData meta=row.getMetaData();
        for(int i=2;i<=meta.getColumnCount();i++){
            String column=meta.getColumnLabel(i),key;
            switch(column){case "space_id":key="spaceId";break;case "task_id":key="taskId";break;case "group_id":key="groupId";break;case "source_run_id":key="sourceRunId";break;case "source_attempt_id":key="sourceAttemptId";break;case "version_id":key="versionId";break;case "run_id":key="runId";break;default:key=column;}
            if(!n.has(key)||!row.getString(i).equals(n.get(key).asText()))throw JdbcApplicationStore.corrupt();
        }return n;
    }
    private void write(String sql,Object...args)throws SQLException{try(PreparedStatement p=prepare(sql,args)){if(p.executeUpdate()!=1)throw JdbcApplicationStore.corrupt();}}
    private ObjectNode one(String sql,Object...args)throws SQLException{try(PreparedStatement p=prepare(sql,args);ResultSet r=p.executeQuery()){if(!r.next())return null;ObjectNode n=associated(r);if(r.next())throw JdbcApplicationStore.corrupt();return n;}}
    public ObjectNode head(String task)throws SQLException{return one("SELECT body_bytes,space_id,task_id,group_id,revision FROM task_delivery_heads WHERE space_id=? AND task_id=? FOR UPDATE",space,task);}
    public void head(ObjectNode n,long expected)throws SQLException {
        if(expected==0)write("INSERT INTO task_delivery_heads(space_id,task_id,group_id,revision,body_bytes) VALUES(?,?,?,?,?)",space,n.path("taskId").textValue(),n.path("groupId").textValue(),n.path("revision").longValue(),bytes(n));
        else write("UPDATE task_delivery_heads SET revision=?,body_bytes=? WHERE space_id=? AND task_id=? AND revision=?",n.path("revision").longValue(),bytes(n),space,n.path("taskId").textValue(),expected);
    }
    public ObjectNode version(String task,String id)throws SQLException{return one("SELECT body_bytes,space_id,id,task_id,number,source_run_id,source_attempt_id FROM task_delivery_versions WHERE space_id=? AND task_id=? AND id=?",space,task,id);}
    public ObjectNode metadata(String task,String id)throws SQLException{return one("SELECT summary_bytes,space_id,id,task_id,number,source_run_id,source_attempt_id FROM task_delivery_versions WHERE space_id=? AND task_id=? AND id=?",space,task,id);}
    public ObjectNode source(String run)throws SQLException{return one("SELECT body_bytes,space_id,id,task_id,number,source_run_id,source_attempt_id FROM task_delivery_versions WHERE space_id=? AND source_run_id=?",space,run);}
    public void version(ObjectNode n)throws SQLException{ObjectNode summary=n.deepCopy();summary.remove("text");write("INSERT INTO task_delivery_versions(space_id,id,task_id,number,source_run_id,source_attempt_id,summary_bytes,body_bytes) VALUES(?,?,?,?,?,?,?,?)",space,n.path("id").textValue(),n.path("taskId").textValue(),n.path("number").longValue(),n.path("sourceRunId").textValue(),n.path("sourceAttemptId").textValue(),bytes(summary),bytes(n));}
    public List<ObjectNode> versions(String task,long before)throws SQLException{
        List<ObjectNode> values=new ArrayList<ObjectNode>();
        try(PreparedStatement p=prepare("SELECT summary_bytes,space_id,id,task_id,number,source_run_id,source_attempt_id FROM task_delivery_versions WHERE space_id=? AND task_id=? AND number<? ORDER BY number DESC LIMIT 41",space,task,before);ResultSet r=p.executeQuery()){while(r.next())values.add(associated(r));}return values;
    }
    public ObjectNode decision(String task,String version)throws SQLException{return one("SELECT body_bytes,space_id,id,task_id,version_id FROM task_delivery_decisions WHERE space_id=? AND task_id=? AND version_id=?",space,task,version);}
    public void decision(ObjectNode n)throws SQLException{write("INSERT INTO task_delivery_decisions(space_id,id,task_id,version_id,body_bytes) VALUES(?,?,?,?,?)",space,n.path("id").textValue(),n.path("taskId").textValue(),n.path("versionId").textValue(),bytes(n));}
    public static final class Command {public final String task;public final byte[] fingerprint;public final ObjectNode receipt;Command(String t,byte[] f,ObjectNode r){task=t;fingerprint=f;receipt=r;}}
    public Command command(String actor,String command)throws SQLException{
        try(PreparedStatement p=prepare("SELECT task_id,fingerprint,receipt_bytes FROM task_delivery_commands WHERE space_id=? AND principal_id=? AND command_id=? FOR UPDATE",space,actor,command);ResultSet r=p.executeQuery()){
            if(!r.next())return null;Command result=new Command(r.getString(1),r.getBytes(2),value(r.getBytes(3)));
            JsonNode summary=result.receipt.path("summary"),head=summary.path("head"),decision=result.receipt.path("decision");String target=result.receipt.path("versionId").textValue();
            if(!summary.isObject()||!head.isObject()||!result.task.equals(summary.path("taskId").textValue())||!space.equals(head.path("spaceId").textValue())||!result.task.equals(head.path("taskId").textValue())||target==null||!target.equals(head.path("versionId").textValue())||!actor.equals(head.path("reviewerPrincipalId").textValue())||!decision.isNull()&&(!decision.isObject()||!space.equals(decision.path("spaceId").textValue())||!result.task.equals(decision.path("taskId").textValue())||!target.equals(decision.path("versionId").textValue())||!actor.equals(decision.path("principalId").textValue())))throw JdbcApplicationStore.corrupt();
            if(result.fingerprint==null||result.fingerprint.length!=32||r.next())throw JdbcApplicationStore.corrupt();return result;
        }
    }
    public void command(String actor,String command,String task,byte[] fingerprint,ObjectNode receipt)throws SQLException{write("INSERT INTO task_delivery_commands(space_id,principal_id,command_id,task_id,fingerprint,receipt_bytes) VALUES(?,?,?,?,?,?)",space,actor,command,task,fingerprint,bytes(receipt));}
    public boolean active(String task,String excluded)throws SQLException{
        try(PreparedStatement p=prepare("SELECT id FROM requirement_run_queue WHERE space_id=? AND task_id=? AND status NOT IN ('succeeded','failed','cancelled') AND id<>? LIMIT 1",space,task,excluded==null?"":excluded);ResultSet r=p.executeQuery()){return r.next();}
    }
    public ObjectNode input(String run)throws SQLException{return one("SELECT body_bytes,space_id,run_id,task_id FROM requirement_run_delivery_inputs WHERE space_id=? AND run_id=?",space,run);}
    public void input(String run,String task,ObjectNode n)throws SQLException{write("UPDATE requirement_run_queue SET delivery_version_id=? WHERE space_id=? AND id=? AND delivery_version_id IS NULL",n.path("versionId").textValue(),space,run);write("INSERT INTO requirement_run_delivery_inputs(space_id,run_id,task_id,body_bytes) VALUES(?,?,?,?)",space,run,task,bytes(n));}
}
