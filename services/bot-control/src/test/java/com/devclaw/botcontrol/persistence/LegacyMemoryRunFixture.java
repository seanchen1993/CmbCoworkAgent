package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.application.RuntimeNodeApplication;
import com.devclaw.botcontrol.application.RuntimeNodeApplication.RequirementDispatch;
import com.devclaw.botcontrol.ports.TrustedContext;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.*;
import java.security.MessageDigest;
import java.sql.*;
import java.time.Instant;
import java.util.*;
import javax.sql.DataSource;

/** Historical schema seeding only. Do not call the current queue store against
 * V5/V6: it correctly requires V7 columns. Raw SQL below reproduces old rows. */
final class LegacyMemoryRunFixture {
    static ObjectNode create(DataSource source,RuntimeNodeApplication nodes,String task,String bot,String command,Instant deadline,String status)throws Exception{
        RequirementDispatch d=nodes.resolveRequirementDispatch(new TrustedContext("A","business"),task,bot);
        String id=UUID.randomUUID().toString(),attempt=UUID.randomUUID().toString(),lease=UUID.randomUUID().toString();
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream hash=new DataOutputStream(bytes);hash.writeUTF("requirement-enqueue-v1");hash.writeUTF(task);hash.writeUTF(bot);hash.writeLong(d.taskVersion);hash.writeLong(deadline.toEpochMilli());hash.flush();
        boolean queued="queued".equals(status);long version=queued?1:"running".equals(status)?3:4;
        try(Connection c=source.getConnection()){
            c.setAutoCommit(false);
            try(PreparedStatement p=c.prepareStatement("INSERT INTO requirement_run_queue(space_id,id,requester_principal_id,command_id,fingerprint,group_id,task_id,stage_id,bot_id,bot_version_id,node_id,owner_principal_id,grant_id,workspace_ref,task_version,group_version,node_version,grant_version,version,initial_status,status,deadline,created_at,updated_at,attempt_id,lease_id,fence,lease_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")){
                Object[] values={"A",id,d.requesterPrincipalId,command,MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray()),d.groupId,d.taskId,d.stageId,d.botId,d.botVersionId,d.nodeId,d.ownerPrincipalId,d.grantId,d.workspaceRef,d.taskVersion,d.groupVersion,d.nodeVersion,d.grantVersion,version,"queued",status,deadline,d.observedAt,d.observedAt,queued?null:attempt,queued?null:lease,queued?null:1,queued?null:deadline};
                p.setQueryTimeout(2);for(int i=0;i<values.length;i++){Object value=values[i];if(value instanceof Instant)p.setTimestamp(i+1,Timestamp.from((Instant)value),Calendar.getInstance(TimeZone.getTimeZone("UTC")));else if(value instanceof byte[])p.setBytes(i+1,(byte[])value);else p.setObject(i+1,value);}if(p.executeUpdate()!=1)throw new IllegalStateException();
            }
            if("succeeded".equals(status))try(PreparedStatement p=c.prepareStatement("INSERT INTO requirement_run_results(space_id,run_id,attempt_id,outcome,result_text,settled_at) VALUES('A',?,?,'succeeded','V5_PERSISTED_RESULT',?)")){p.setQueryTimeout(2);p.setString(1,id);p.setString(2,attempt);p.setTimestamp(3,Timestamp.from(d.observedAt),Calendar.getInstance(TimeZone.getTimeZone("UTC")));if(p.executeUpdate()!=1)throw new IllegalStateException();}
            c.commit();
        }
        ObjectNode result=CompatibilityProbe.strictMapper().createObjectNode().put("id",id).put("groupId",d.groupId).put("version",version).put("deadline",deadline.toString());
        if(!queued)result.put("attemptId",attempt).put("leaseId",lease).put("fence",1).put("leaseExpiresAt",deadline.toString());return result;
    }
}
