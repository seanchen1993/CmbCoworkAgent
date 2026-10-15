package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.application.GroupMemoryValues.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.ports.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Expert knowledge is shared by explicit adoption, never learnt from a Group.
 * Maintenance locks Bot only. Adoption locks Group -> Bot, as execution does. */
public final class ExpertMemoryApplication {
    private final DataSource source; private final IdentityPolicy identity;
    public ExpertMemoryApplication(DataSource source,IdentityPolicy identity){this.source=source;this.identity=identity;}
    private static ApplicationFault fault(ErrorCode code){return new ApplicationFault(code);}
    private void actor(TrustedContext actor){
        if(actor==null||actor.principalId==null)throw fault(ErrorCode.UNAUTHENTICATED);
        GroupMemoryValues.id(actor.spaceId);GroupMemoryValues.id(actor.principalId);
        if(!identity.activeMember(actor.spaceId,actor.principalId))throw fault(ErrorCode.FORBIDDEN);
    }
    private static Bot maintainer(JdbcApplicationStore db,TrustedContext actor,String botId)throws SQLException{
        Bot bot=db.bot(botId);if(bot==null)throw fault(ErrorCode.NOT_FOUND);
        if(!bot.maintainerIds.contains(actor.principalId)||bot.status!=BotStatus.ACTIVE)throw fault(ErrorCode.FORBIDDEN);return bot;
    }
    private interface Work<T>{T run(Connection c,JdbcApplicationStore db,JdbcGroupMemoryStore store)throws SQLException;}
    private <T>T transaction(TrustedContext actor,boolean write,Work<T> work){
        actor(actor);boolean attempted=false;
        try(Connection c=source.getConnection()){
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);c.setAutoCommit(false);
            try{JdbcApplicationStore db=new JdbcApplicationStore(c,actor.spaceId,TransactionObserver.NONE);if(write)db.lockScope(actor.principalId);
                T result=work.run(c,db,new JdbcGroupMemoryStore(c,actor.spaceId,true));attempted=true;c.commit();return result;
            }catch(SQLException|RuntimeException failure){if(!attempted)try{c.rollback();}catch(SQLException ignored){}if(attempted&&write)throw fault(ErrorCode.OUTCOME_UNKNOWN);if(failure instanceof ApplicationFault)throw (ApplicationFault)failure;throw JdbcApplicationStore.corrupt();}
        }catch(SQLException failure){throw fault(attempted&&write?ErrorCode.OUTCOME_UNKNOWN:ErrorCode.DEPENDENCY_UNAVAILABLE);}
    }
    public static final class Listed {
        public final String botId;public final long revision;public final List<Memory> memories;public final boolean canManage=true;
        private Listed(String bot,long revision,List<Memory> memories){botId=bot;this.revision=revision;this.memories=Collections.unmodifiableList(memories);}
    }
    public Listed list(TrustedContext actor,String botId){
        GroupMemoryValues.id(botId);return transaction(actor,false,(c,db,store)->{maintainer(db,actor,botId);long revision=store.revision(botId);return new Listed(botId,revision,store.list(botId,revision));});
    }
    public Changed create(TrustedContext actor,String bot,String command,String text){return write(actor,"createExpertMemory",bot,null,command,0,GroupMemoryValues.text(text),"active");}
    public Changed update(TrustedContext actor,String bot,String memory,String command,long expected,String text,String status){return write(actor,"updateExpertMemory",bot,memory,command,GroupMemoryValues.version(expected,1),GroupMemoryValues.text(text),GroupMemoryValues.status(status));}
    public Changed disable(TrustedContext actor,String bot,String memory,String command,long expected){return write(actor,"disableExpertMemory",bot,memory,command,GroupMemoryValues.version(expected,1),null,"disabled");}
    private Changed write(TrustedContext actor,String operation,String botId,String memoryId,String command,long expected,String text,String status){
        GroupMemoryValues.id(botId);GroupMemoryValues.id(command);if(memoryId!=null)GroupMemoryValues.id(memoryId);
        final byte[] fingerprint;
        try{fingerprint=MessageDigest.getInstance("SHA-256").digest(GroupMemoryValues.encode(Arrays.asList("expert-memory-v1",operation,botId,memoryId,expected,text,status)).getBytes(StandardCharsets.UTF_8));}catch(Exception failure){throw JdbcApplicationStore.corrupt();}
        return transaction(actor,true,(c,db,store)->{
            // Authorization precedes command replay, including after revocation.
            maintainer(db,actor,botId);JdbcGroupMemoryStore.Command oldCommand=store.command(actor.principalId,command);
            if(oldCommand!=null)return oldCommand.replay(fingerprint,actor.spaceId,true);
            long revision=store.revision(botId);List<Memory> values=store.list(botId,revision);Memory old=null;
            if(memoryId!=null){for(Memory m:values)if(memoryId.equals(m.id))old=m;if(old==null)throw fault(ErrorCode.NOT_FOUND);if(old.version!=expected)throw new ApplicationFault(ErrorCode.VERSION_CONFLICT,old.version);}
            else if(values.size()>=100)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
            if(revision==JdbcTaskStore.MAX||old!=null&&old.version==JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
            Source manual=GroupMemoryValues.decodeSource("{\"kind\":\"manual\"}");String now=GroupMemoryValues.date(db.now().toInstant());
            Memory value=new Memory(old==null?UUID.randomUUID().toString():old.id,actor.spaceId,botId,old==null?1:old.version+1,text==null?old.text:text,status,manual,old==null?actor.principalId:old.createdBy,actor.principalId,old==null?now:old.createdAt,now,true);
            if(old!=null)values.remove(old);values.add(value);Collections.sort(values,Comparator.comparing(m->m.id));GroupMemoryValues.validateMemories(values,false);GroupMemoryValues.budget(values);
            store.write(value,old,revision);Changed changed=new Changed(revision+1,value);store.receipt(actor.principalId,command,fingerprint,changed);return changed;
        });
    }
    public static final class Adoption {public final boolean adopted;private Adoption(boolean value){adopted=value;}}
    public static final class Overview {
        public final boolean adopted,canManage;public final String botName;
        private Overview(boolean adopted,Bot bot,TrustedContext actor){this.adopted=adopted;botName=bot.name;canManage=bot.status==BotStatus.ACTIVE&&bot.maintainerIds.contains(actor.principalId);}
    }
    public Overview adoption(TrustedContext actor,String groupId,String botId){
        GroupMemoryValues.id(groupId);GroupMemoryValues.id(botId);
        return transaction(actor,false,(c,db,store)->{Group group=db.group(groupId);if(group==null)throw fault(ErrorCode.NOT_FOUND);if(!ReceiptAccess.member(actor,group,true))throw fault(ErrorCode.FORBIDDEN);if(group.bots.size()!=1||!group.bots.get(0).botId.equals(botId))throw fault(ErrorCode.INPUT_CHANGED);Bot bot=db.bot(botId);if(bot==null)throw JdbcApplicationStore.corrupt();return new Overview(adopted(c,actor.spaceId,groupId,botId),bot,actor);});
    }
    private static boolean adopted(Connection c,String space,String group,String bot)throws SQLException{
        try(PreparedStatement p=c.prepareStatement("SELECT bot_id FROM group_expert_memory_modes WHERE space_id=? AND group_id=?")){p.setQueryTimeout(2);p.setString(1,space);p.setString(2,group);try(ResultSet row=p.executeQuery()){if(!row.next())return false;boolean same=bot.equals(row.getString(1));if(row.next())throw JdbcApplicationStore.corrupt();return same;}}
    }
    /** Monotonic desired-state operation: same target is idempotent, no text copy,
     * no Group version mutation, no node grant. Current permissions rechecked. */
    public Adoption activate(TrustedContext actor,String groupId,String botId,String botVersionId,long expectedGroupVersion){
        GroupMemoryValues.id(groupId);GroupMemoryValues.id(botId);GroupMemoryValues.id(botVersionId);GroupMemoryValues.version(expectedGroupVersion,1);
        return transaction(actor,true,(c,db,store)->{
            Group group=db.group(groupId);if(group==null)throw fault(ErrorCode.NOT_FOUND);if(!ReceiptAccess.member(actor,group,true))throw fault(ErrorCode.FORBIDDEN);
            maintainer(db,actor,botId);
            if(group.version!=expectedGroupVersion||group.bots.size()!=1||!group.bots.get(0).botId.equals(botId)||!group.bots.get(0).botVersionId.equals(botVersionId))throw fault(ErrorCode.INPUT_CHANGED);
            BotVersion version=db.version(botVersionId);if(version==null||!botId.equals(version.botId)||version.config.memoryPolicy!=BotConfigMemoryPolicy.EXPLICIT_ONLY)throw fault(ErrorCode.INPUT_CHANGED);
            if(!adopted(c,actor.spaceId,groupId,botId))try(PreparedStatement p=c.prepareStatement("INSERT INTO group_expert_memory_modes(space_id,group_id,bot_id) VALUES(?,?,?) ON DUPLICATE KEY UPDATE bot_id=VALUES(bot_id)")){p.setQueryTimeout(2);p.setString(1,actor.spaceId);p.setString(2,groupId);p.setString(3,botId);p.executeUpdate();}
            return new Adoption(true);
        });
    }
}
