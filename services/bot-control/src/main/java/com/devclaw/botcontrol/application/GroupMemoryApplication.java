package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.application.GroupMemoryValues.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.ports.*;
import java.io.*;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Current Group members read, current Group admins publish; never Bot ownership. */
public final class GroupMemoryApplication {
    private final DataSource source;private final IdentityPolicy identity;private final TransactionObserver observer;
    public GroupMemoryApplication(DataSource source,IdentityPolicy identity,TransactionObserver observer){this.source=source;this.identity=identity;this.observer=observer;}
    private static ApplicationFault fault(ErrorCode code){return new ApplicationFault(code);}
    private void actor(TrustedContext actor){if(actor==null||actor.principalId==null)throw fault(ErrorCode.UNAUTHENTICATED);GroupMemoryValues.id(actor.spaceId);GroupMemoryValues.id(actor.principalId);if(!identity.activeMember(actor.spaceId,actor.principalId))throw fault(ErrorCode.FORBIDDEN);}
    private static Group group(JdbcApplicationStore db,TrustedContext actor,String id,boolean admin)throws SQLException {Group group=db.group(id);if(group==null)throw fault(ErrorCode.NOT_FOUND);if(!ReceiptAccess.member(actor,group,admin))throw fault(ErrorCode.FORBIDDEN);return group;}
    private interface Work<T>{T run(Connection c,JdbcApplicationStore db,JdbcGroupMemoryStore memories)throws SQLException;}
    private <T>T transaction(TrustedContext actor,boolean write,Work<T> work){
        boolean attempted=false;
        try(Connection c=source.getConnection()){
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);c.setAutoCommit(false);
            try{JdbcApplicationStore db=new JdbcApplicationStore(c,actor.spaceId,observer);if(write)db.lockScope(actor.principalId);
                T result=work.run(c,db,new JdbcGroupMemoryStore(c,actor.spaceId));if(write)observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);attempted=true;c.commit();if(write)observer.reached(TransactionObserver.Stage.AFTER_COMMIT);return result;
            }catch(SQLException|RuntimeException failure){if(!attempted)try{c.rollback();}catch(SQLException ignored){}if(attempted&&write)throw fault(ErrorCode.OUTCOME_UNKNOWN);if(failure instanceof ApplicationFault)throw (ApplicationFault)failure;throw JdbcApplicationStore.corrupt();}
        }catch(SQLException failure){throw fault(attempted&&write?ErrorCode.OUTCOME_UNKNOWN:ErrorCode.DEPENDENCY_UNAVAILABLE);}
    }
    public static final class Policy {
        public final String botId,botVersionId,memoryPolicy;
        private Policy(GroupBot binding,BotVersion version){botId=binding.botId;botVersionId=binding.botVersionId;memoryPolicy=version.config.memoryPolicy.wire();}
    }
    public static final class Listed {
        public final long revision;public final List<Memory> memories;public final List<Policy> botPolicies;public final boolean canManage;
        private Listed(long revision,List<Memory> memories,List<Policy> policies,boolean canManage){this.revision=revision;this.memories=memories;botPolicies=policies;this.canManage=canManage;}
    }
    public Listed listGroupMemories(TrustedContext actor,String groupId){
        actor(actor);GroupMemoryValues.id(groupId);
        return transaction(actor,false,(c,db,store)->{Group group=group(db,actor,groupId,false);long revision=store.revision(groupId);List<Memory> values=store.list(groupId,revision);List<Policy> policies=new ArrayList<Policy>();
            for(GroupBot binding:group.bots){BotVersion version=db.version(binding.botVersionId);if(version==null||!actor.spaceId.equals(version.spaceId)||!binding.botId.equals(version.botId))throw JdbcApplicationStore.corrupt();policies.add(new Policy(binding,version));}
            Collections.sort(policies,Comparator.comparing(value->value.botId));return new Listed(revision,Collections.unmodifiableList(values),Collections.unmodifiableList(policies),ReceiptAccess.member(actor,group,true));
        });
    }
    private static byte[] fingerprint(String operation,String group,String memory,long expected,String text,Source source,String status){
        try{ByteArrayOutputStream bytes=new ByteArrayOutputStream();DataOutputStream out=new DataOutputStream(bytes);out.writeUTF("group-explicit-memory-v1");out.writeUTF(operation);out.writeUTF(group);out.writeUTF(memory==null?"":memory);out.writeLong(expected);out.writeUTF(text==null?"":text);out.writeUTF(source==null?"":GroupMemoryValues.encode(source));out.writeUTF(status==null?"":status);out.flush();return MessageDigest.getInstance("SHA-256").digest(bytes.toByteArray());}catch(Exception failure){throw JdbcApplicationStore.corrupt();}
    }
    private static void source(Connection c,TrustedContext actor,String group,Source source,boolean currentVersion)throws SQLException {
        if("task".equals(source.kind)){JdbcTaskStore tasks=new JdbcTaskStore(c,actor.spaceId);String actual=tasks.groupId(source.taskId);if(actual==null)throw fault(ErrorCode.NOT_FOUND);if(!group.equals(actual))throw fault(ErrorCode.FORBIDDEN);Task task=tasks.task(source.taskId);if(task==null||!group.equals(task.groupId))throw JdbcApplicationStore.corrupt();if(currentVersion&&task.version!=source.taskVersion)throw fault(ErrorCode.INPUT_CHANGED);}
        else if("result".equals(source.kind)){JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,actor.spaceId);String actual=runs.groupId(source.runId);if(actual==null)throw fault(ErrorCode.NOT_FOUND);if(!group.equals(actual))throw fault(ErrorCode.FORBIDDEN);Run run=runs.run(source.runId);Result result=runs.result(source.runId);if(run==null||!group.equals(run.groupId))throw JdbcApplicationStore.corrupt();RequirementRunApplication.storedResult(run,result);if(result==null)throw fault(ErrorCode.INVALID_PAYLOAD);}
    }
    public Changed createGroupMemory(TrustedContext actor,String group,String command,String text,Source source){return write(actor,"createGroupMemory",group,null,command,0,GroupMemoryValues.text(text),source,"active");}
    public Changed updateGroupMemory(TrustedContext actor,String group,String memory,String command,long expected,String text,Source source,String status){return write(actor,"updateGroupMemory",group,memory,command,GroupMemoryValues.version(expected,1),GroupMemoryValues.text(text),source,GroupMemoryValues.status(status));}
    public Changed disableGroupMemory(TrustedContext actor,String group,String memory,String command,long expected){return write(actor,"disableGroupMemory",group,memory,command,GroupMemoryValues.version(expected,1),null,null,null);}
    private Changed write(TrustedContext actor,String operation,String groupId,String memoryId,String command,long expected,String text,Source source,String status){
        actor(actor);GroupMemoryValues.id(groupId);GroupMemoryValues.id(command);if(memoryId!=null)GroupMemoryValues.id(memoryId);if(source!=null)source=GroupMemoryValues.source(com.devclaw.botcontrol.CompatibilityProbe.strictMapper().valueToTree(source));else if(!"disableGroupMemory".equals(operation))throw fault(ErrorCode.INVALID_PAYLOAD);
        final Source supplied=source;byte[] hash=fingerprint(operation,groupId,memoryId,expected,text,supplied,status);
        return transaction(actor,true,(c,db,store)->{
            JdbcGroupMemoryStore.Command previous=store.command(actor.principalId,command);
            if(previous!=null){group(db,actor,previous.groupId,true);Changed replay=previous.replay(hash,actor.spaceId);source(c,actor,previous.groupId,replay.memory.source,false);return replay;}
            group(db,actor,groupId,true);long revision=store.revision(groupId);List<Memory> values=store.list(groupId,revision);Memory old=null;
            if(memoryId!=null){for(Memory value:values)if(memoryId.equals(value.id))old=value;if(old==null)throw fault(ErrorCode.NOT_FOUND);if(old.version!=expected)throw new ApplicationFault(ErrorCode.VERSION_CONFLICT,old.version);}
            else if(values.size()>=100)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
            if(revision==JdbcTaskStore.MAX||old!=null&&old.version==JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
            Source selected=supplied==null?old.source:supplied;
            // A disable retains historical provenance; publishing/replacing checks current sources.
            source(c,actor,groupId,selected,supplied!=null);
            String now=GroupMemoryValues.date(db.now().toInstant());Memory value=new Memory(old==null?UUID.randomUUID().toString():old.id,actor.spaceId,groupId,old==null?1:old.version+1,text==null?old.text:text,status==null?"disabled":status,selected,old==null?actor.principalId:old.createdBy,actor.principalId,old==null?now:old.createdAt,now);
            if(old!=null)values.remove(old);values.add(value);Collections.sort(values,Comparator.comparing(item->item.id));GroupMemoryValues.validateMemories(values,false);GroupMemoryValues.budget(values);
            store.write(value,old,revision);Changed changed=new Changed(revision+1,value);store.receipt(actor.principalId,command,hash,changed);return changed;
        });
    }
    public static final class Inspected {public final Snapshot memorySnapshot;private Inspected(Snapshot snapshot){memorySnapshot=snapshot;}}
    public Inspected inspectMemorySnapshot(TrustedContext actor,String runId){actor(actor);GroupMemoryValues.id(runId);return transaction(actor,false,(c,db,memories)->{
        JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,actor.spaceId);String group=runs.groupId(runId);if(group==null)throw fault(ErrorCode.NOT_FOUND);group(db,actor,group,false);Run run=runs.run(runId);if(run==null||!group.equals(run.groupId))throw JdbcApplicationStore.corrupt();JdbcGroupMemoryStore.Frozen snapshot=memories.snapshot(run);if(!snapshot.found)throw fault(ErrorCode.NOT_FOUND);return new Inspected(snapshot.value);
    });}
}
