package com.devclaw.botcontrol.persistence;

import com.devclaw.botcontrol.application.GroupMemoryValues;
import com.devclaw.botcontrol.application.GroupMemoryValues.*;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.Run;
import java.security.MessageDigest;
import java.sql.*;
import java.time.Instant;
import java.util.*;

/** Shared bounded explicit-memory storage. Caller holds Group (legacy) or Bot
 * (expert) parent lock. Table/column selectors are fixed constants, never input. */
public final class JdbcGroupMemoryStore {
    private final Connection c;private final String space,key,prefix;private final boolean expert;
    public JdbcGroupMemoryStore(Connection c,String space){this(c,space,false);}
    public JdbcGroupMemoryStore(Connection c,String space,boolean expert){this.c=c;this.space=space;this.expert=expert;key=expert?"bot_id":"group_id";prefix=expert?"bot_":"group_";}
    private static Calendar utc(){return Calendar.getInstance(TimeZone.getTimeZone("UTC"));}
    private PreparedStatement prepare(String sql,Object... values)throws SQLException {
        PreparedStatement p=c.prepareStatement(sql);try{p.setQueryTimeout(2);for(int i=0;i<values.length;i++){Object value=values[i];if(value instanceof Instant)p.setTimestamp(i+1,Timestamp.from((Instant)value),utc());else if(value instanceof byte[])p.setBytes(i+1,(byte[])value);else p.setObject(i+1,value);}return p;}catch(SQLException failure){p.close();throw failure;}
    }
    private void change(String sql,Object... values)throws SQLException {try(PreparedStatement p=prepare(sql,values)){if(p.executeUpdate()!=1)throw JdbcApplicationStore.corrupt();}}
    private static String date(ResultSet row,String key)throws SQLException {Timestamp value=row.getTimestamp(key,utc());if(value==null||value.getNanos()%1000000!=0)throw JdbcApplicationStore.corrupt();return GroupMemoryValues.date(value.toInstant());}
    public long revision(String group)throws SQLException {
        try(PreparedStatement p=prepare("SELECT revision FROM "+prefix+"memory_revisions WHERE space_id=? AND "+key+"=? FOR UPDATE",space,group);ResultSet row=p.executeQuery()){
            if(!row.next())return 0;long value=row.getLong(1);if(value<1||value>JdbcTaskStore.MAX||row.next())throw JdbcApplicationStore.corrupt();return value;
        }
    }
    public List<Memory> list(String group,long revision)throws SQLException {
        List<Memory> values=new ArrayList<Memory>();
        try(PreparedStatement p=prepare("SELECT * FROM "+prefix+"memories WHERE space_id=? AND "+key+"=? ORDER BY id LIMIT 101 FOR UPDATE",space,group);ResultSet row=p.executeQuery()){
            while(row.next()){
                if(values.size()==100)throw JdbcApplicationStore.corrupt();
                try{Memory value=new Memory(row.getString("id"),row.getString("space_id"),row.getString(key),row.getLong("version"),row.getString("memory_text"),row.getString("status"),GroupMemoryValues.decodeSource(row.getString("source_json")),row.getString("created_by"),row.getString("updated_by"),date(row,"created_at"),date(row,"updated_at"),expert);
                    if(!space.equals(value.spaceId)||!group.equals(value.ownerId())||value.version>revision)throw JdbcApplicationStore.corrupt();values.add(value);
                }catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}
            }
        }
        try{GroupMemoryValues.validateMemories(values,false);GroupMemoryValues.budget(values);}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}
        return values;
    }
    public void write(Memory value,Memory old,long revision)throws SQLException {
        if(revision<0||revision>=JdbcTaskStore.MAX)throw JdbcApplicationStore.corrupt();
        if(expert!=(value.botId!=null))throw JdbcApplicationStore.corrupt();
        if(old==null)change("INSERT INTO "+prefix+"memories(space_id,"+key+",id,version,memory_text,status,source_json,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",space,value.ownerId(),value.id,value.version,value.text,value.status,GroupMemoryValues.encode(value.source),value.createdBy,value.updatedBy,Instant.parse(value.createdAt),Instant.parse(value.updatedAt));
        else change("UPDATE "+prefix+"memories SET version=?,memory_text=?,status=?,source_json=?,updated_by=?,updated_at=? WHERE space_id=? AND "+key+"=? AND id=? AND version=?",value.version,value.text,value.status,GroupMemoryValues.encode(value.source),value.updatedBy,Instant.parse(value.updatedAt),space,value.ownerId(),value.id,old.version);
        if(revision==0)change("INSERT INTO "+prefix+"memory_revisions(space_id,"+key+",revision) VALUES(?,?,1)",space,value.ownerId());
        else change("UPDATE "+prefix+"memory_revisions SET revision=? WHERE space_id=? AND "+key+"=? AND revision=?",revision+1,space,value.ownerId(),revision);
    }
    public static final class Command {
        public final String groupId;private final byte[] fingerprint;private final String receipt;
        private Command(String group,byte[] fingerprint,String receipt){groupId=group;this.fingerprint=fingerprint;this.receipt=receipt;}
        public Changed replay(byte[] hash,String space){return replay(hash,space,false);}
        public Changed replay(byte[] hash,String space,boolean expert){
            if(!MessageDigest.isEqual(fingerprint,hash))throw new com.devclaw.botcontrol.domain.ApplicationFault(com.devclaw.botcontrol.contracts.BotContracts.ErrorCode.COMMAND_CONFLICT);
            try{Changed value=GroupMemoryValues.decodeChanged(receipt);if(!space.equals(value.memory.spaceId)||!groupId.equals(value.memory.ownerId())||expert!=(value.memory.botId!=null)||value.memory.version>value.revision)throw JdbcApplicationStore.corrupt();return value;}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}
        }
    }
    public Command command(String principal,String command)throws SQLException {
        try(PreparedStatement p=prepare("SELECT "+key+",fingerprint,receipt_json FROM "+prefix+"memory_commands WHERE space_id=? AND principal_id=? AND command_id=? FOR UPDATE",space,principal,command);ResultSet row=p.executeQuery()){
            if(!row.next())return null;String group=row.getString(1),receipt=row.getString(3);byte[] hash=row.getBytes(2);if(hash==null||hash.length!=32||receipt==null||receipt.length()>65536||row.next())throw JdbcApplicationStore.corrupt();
            try{GroupMemoryValues.id(group);}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}return new Command(group,hash,receipt);
        }
    }
    public void receipt(String principal,String command,byte[] hash,Changed value)throws SQLException {change("INSERT INTO "+prefix+"memory_commands(space_id,principal_id,command_id,"+key+",fingerprint,receipt_json) VALUES(?,?,?,?,?,?)",space,principal,command,value.memory.ownerId(),hash,GroupMemoryValues.encode(value));}
    public static final class Frozen {
        public final boolean found;public final Snapshot value;
        private Frozen(boolean found,Snapshot value){this.found=found;this.value=value;}
    }
    public Frozen snapshot(Run run)throws SQLException {
        try(PreparedStatement p=prepare("SELECT attempt_id,snapshot_json FROM requirement_run_memory_snapshots WHERE space_id=? AND run_id=?",space,run.id);ResultSet row=p.executeQuery()){
            if(!row.next())return new Frozen(false,null);String attempt=row.getString(1),json=row.getString(2);if(!Objects.equals(run.attemptId,attempt)||json==null||json.length()>65536||row.next())throw JdbcApplicationStore.corrupt();
            try{return new Frozen(true,GroupMemoryValues.decodeSnapshot(json,space,"bot".equals(run.memoryScope)?run.botId:run.groupId,"bot".equals(run.memoryScope)));}catch(RuntimeException failure){throw JdbcApplicationStore.corrupt();}
        }
    }
    public Snapshot freeze(Run run,String policy)throws SQLException {
        Frozen old=snapshot(run);if(old.found)return old.value;
        Snapshot snapshot;
        if("disabled".equals(policy))snapshot=null;
        else if("explicit_only".equals(policy)){boolean bot="bot".equals(run.memoryScope);JdbcGroupMemoryStore selected=new JdbcGroupMemoryStore(c,space,bot);String owner=bot?run.botId:run.groupId;long revision=selected.revision(owner);List<Memory> active=new ArrayList<Memory>();for(Memory value:selected.list(owner,revision))if("active".equals(value.status))active.add(value);snapshot=new Snapshot(revision,active,bot?run.botId:null);}
        else throw JdbcApplicationStore.corrupt();
        change("INSERT INTO requirement_run_memory_snapshots(space_id,run_id,attempt_id,snapshot_json) VALUES(?,?,?,?)",space,run.id,run.attemptId,GroupMemoryValues.encode(snapshot));return snapshot;
    }
    public boolean changed(Run run)throws SQLException {
        Frozen snapshot=snapshot(run);if(!snapshot.found)throw JdbcApplicationStore.corrupt();if(snapshot.value==null)return false;
        boolean bot="bot".equals(run.memoryScope);long current=new JdbcGroupMemoryStore(c,space,bot).revision(bot?run.botId:run.groupId);if(current<snapshot.value.revision)throw JdbcApplicationStore.corrupt();return current!=snapshot.value.revision;
    }
}
