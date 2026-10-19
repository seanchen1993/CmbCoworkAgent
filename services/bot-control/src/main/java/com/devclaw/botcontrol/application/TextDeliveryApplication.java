package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.ports.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Internal text review, not file Artifact, transport Delivery or tool Approval. */
public final class TextDeliveryApplication {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private final DataSource source; private final IdentityPolicy identity; private final TransactionObserver observer;
    public TextDeliveryApplication(DataSource source,IdentityPolicy identity,TransactionObserver observer){this.source=source;this.identity=identity;this.observer=observer;}
    private static ApplicationFault fault(ErrorCode code){return new ApplicationFault(code);}
    private static String id(String value){return GroupMemoryValues.id(value);}
    private static String text(String value){
        if(value==null||value.trim().isEmpty()||value.codePointCount(0,value.length())>16384)throw fault(ErrorCode.INVALID_PAYLOAD);
        for(int i=0;i<value.length();i++){char ch=value.charAt(i);if(Character.isHighSurrogate(ch)){if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i)))throw fault(ErrorCode.INVALID_PAYLOAD);}else if(ch==0||Character.isLowSurrogate(ch))throw fault(ErrorCode.INVALID_PAYLOAD);}return value;
    }
    private static long version(long value,long minimum){return GroupMemoryValues.version(value,minimum);}
    private static String uuid(){return UUID.randomUUID().toString();}
    private static String now(JdbcApplicationStore db)throws SQLException{return JdbcApplicationStore.text(db.now());}
    private static ObjectNode object(){return JSON.createObjectNode();}
    private void actor(TrustedContext actor){if(actor==null||actor.principalId==null)throw fault(ErrorCode.UNAUTHENTICATED);id(actor.spaceId);id(actor.principalId);if(!identity.activeMember(actor.spaceId,actor.principalId))throw fault(ErrorCode.FORBIDDEN);}
    private static Group group(JdbcApplicationStore db,TrustedContext actor,String group)throws SQLException{Group g=db.group(group);if(g==null)throw fault(ErrorCode.NOT_FOUND);if(!ReceiptAccess.member(actor,g,false))throw fault(ErrorCode.FORBIDDEN);return g;}
    private static Task task(JdbcApplicationStore db,JdbcTaskStore tasks,TrustedContext actor,String task)throws SQLException{String group=tasks.groupId(task);if(group==null)throw fault(ErrorCode.NOT_FOUND);group(db,actor,group);Task t=tasks.task(task);if(t==null||!group.equals(t.groupId))throw JdbcApplicationStore.corrupt();return t;}
    private interface Work<T>{T run(Connection c,JdbcApplicationStore db,JdbcTaskStore tasks,JdbcTextDeliveryStore store,long head)throws SQLException;}
    private <T>T transaction(TrustedContext actor,boolean write,Work<T> work){
        boolean attempted=false;
        try(Connection c=source.getConnection()){
            c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);c.setAutoCommit(false);
            try{JdbcApplicationStore db=new JdbcApplicationStore(c,actor.spaceId,observer);JdbcTaskStore tasks=new JdbcTaskStore(c,actor.spaceId);if(write)db.lockScope(actor.principalId);long head=write?tasks.lockHead():0;
                T result=work.run(c,db,tasks,new JdbcTextDeliveryStore(c,actor.spaceId),head);if(write)observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);attempted=true;c.commit();if(write)observer.reached(TransactionObserver.Stage.AFTER_COMMIT);return result;
            }catch(SQLException|RuntimeException failure){if(!attempted)try{c.rollback();}catch(SQLException ignored){}if(attempted&&write)throw fault(ErrorCode.OUTCOME_UNKNOWN);if(failure instanceof ApplicationFault)throw (ApplicationFault)failure;throw JdbcApplicationStore.corrupt();}
        }catch(SQLException failure){throw fault(attempted&&write?ErrorCode.OUTCOME_UNKNOWN:ErrorCode.DEPENDENCY_UNAVAILABLE);}
    }
    private static String digest(String text){try{byte[] hash=MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder("sha256:");for(byte b:hash)out.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return out.toString();}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private static byte[] fingerprint(ObjectNode value){try{return MessageDigest.getInstance("SHA-256").digest(JSON.writeValueAsBytes(value));}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private static void next(Task task){if(task.version>=JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);task.version++;}
    public static void shape(Task task,String status){
        task.status=TaskStatus.fromWire(status);
        for(int i=0;i<task.stages.size();i++)task.stages.get(i).status=i==0?(task.status==TaskStatus.ACTIVE?StageStatus.ACTIVE:task.status==TaskStatus.AWAITING_BUSINESS?StageStatus.WAITING_CONFIRMATION:StageStatus.COMPLETED):(task.status==TaskStatus.COMPLETED?StageStatus.CANCELLED:StageStatus.PENDING);
    }
    private static ObjectNode head(JdbcTextDeliveryStore store,Task task)throws SQLException{
        ObjectNode h=store.head(task.id);if(h==null){if(task.status!=TaskStatus.ACTIVE&&!store.expert(task.id))throw JdbcApplicationStore.corrupt();return null;}
        if(!task.spaceId.equals(h.path("spaceId").textValue())||!task.groupId.equals(h.path("groupId").textValue())||!task.id.equals(h.path("taskId").textValue())||h.path("revision").longValue()<1||h.path("revision").longValue()>JdbcTaskStore.MAX||h.path("number").longValue()<1||!Arrays.asList("pending","changes_requested","invalidated","completed").contains(h.path("status").textValue()))throw JdbcApplicationStore.corrupt();
        try{id(h.path("botId").textValue());id(h.path("versionId").textValue());id(h.path("reviewerPrincipalId").textValue());if(!h.path("feedbackMessageId").isNull())id(h.path("feedbackMessageId").textValue());}catch(ApplicationFault failure){throw JdbcApplicationStore.corrupt();}
        ObjectNode metadata=store.metadata(task.id,h.path("versionId").textValue());
        if(metadata==null||!task.spaceId.equals(metadata.path("spaceId").textValue())||!task.groupId.equals(metadata.path("groupId").textValue())||!h.path("botId").equals(metadata.path("botId"))||!h.path("reviewerPrincipalId").equals(metadata.path("createdBy"))||h.path("number").longValue()!=metadata.path("number").longValue()||!store.expert(task.id)&&(task.status==TaskStatus.AWAITING_BUSINESS&&!"pending".equals(h.path("status").textValue())||task.status==TaskStatus.COMPLETED&&!"completed".equals(h.path("status").textValue())||task.status==TaskStatus.ACTIVE&&!Arrays.asList("invalidated","changes_requested").contains(h.path("status").textValue())))throw JdbcApplicationStore.corrupt();return h;
    }
    private static ObjectNode delivery(JdbcTextDeliveryStore store,Task task,String version)throws SQLException{
        ObjectNode v=store.version(task.id,version);if(v==null)throw fault(ErrorCode.NOT_FOUND);
        try{String text=text(v.path("text").textValue());if(!task.spaceId.equals(v.path("spaceId").textValue())||!task.id.equals(v.path("taskId").textValue())||!task.groupId.equals(v.path("groupId").textValue())||!version.equals(v.path("id").textValue())||!digest(text).equals(v.path("digest").textValue())||text.getBytes(StandardCharsets.UTF_8).length!=v.path("sizeBytes").longValue()||v.path("number").longValue()<1)throw JdbcApplicationStore.corrupt();}
        catch(ApplicationFault failure){throw JdbcApplicationStore.corrupt();}return v;
    }
    private static ObjectNode summary(TrustedContext actor,Task task,ObjectNode h,JdbcTextDeliveryStore store)throws SQLException{
        ObjectNode result=object().put("taskId",task.id).put("taskVersion",task.version).put("taskStatus",task.status.wire());result.set("head",h==null?NullNode.instance:h);
        result.put("canReview",h!=null&&"pending".equals(h.path("status").textValue())&&actor.principalId.equals(h.path("reviewerPrincipalId").textValue())&&!store.expert(task.id)&&task.status==TaskStatus.AWAITING_BUSINESS&&!store.active(task.id,null));return result;
    }
    public ObjectNode summaries(TrustedContext actor,List<String> ids){actor(actor);if(ids==null||ids.isEmpty()||ids.size()>40||new HashSet<String>(ids).size()!=ids.size())throw fault(ErrorCode.INVALID_PAYLOAD);for(String id:ids)id(id);
        return transaction(actor,false,(c,db,tasks,store,eventHead)->{ArrayNode values=JSON.createArrayNode();List<String> sorted=new ArrayList<String>(ids);Collections.sort(sorted);for(String id:sorted){Task task=task(db,tasks,actor,id);values.add(summary(actor,task,head(store,task),store));}ObjectNode result=object();result.set("items",values);return result;});
    }
    public ObjectNode versions(TrustedContext actor,String taskId,long before){actor(actor);id(taskId);version(before,1);
        return transaction(actor,false,(c,db,tasks,store,eventHead)->{Task task=task(db,tasks,actor,taskId);List<ObjectNode> page=store.versions(taskId,before);ArrayNode values=JSON.createArrayNode();for(int i=0;i<Math.min(40,page.size());i++){ObjectNode v=page.get(i);if(!task.spaceId.equals(v.path("spaceId").textValue())||!task.id.equals(v.path("taskId").textValue())||!task.groupId.equals(v.path("groupId").textValue())||v.has("text"))throw JdbcApplicationStore.corrupt();values.add(v);}ObjectNode result=object();result.set("items",values);if(page.size()>40)result.put("nextBefore",page.get(39).path("number").longValue());else result.putNull("nextBefore");return result;});
    }
    public ObjectNode read(TrustedContext actor,String taskId,String versionId){actor(actor);id(taskId);id(versionId);
        return transaction(actor,false,(c,db,tasks,store,eventHead)->{Task task=task(db,tasks,actor,taskId);ObjectNode result=object();result.set("summary",summary(actor,task,head(store,task),store));result.set("version",delivery(store,task,versionId));ObjectNode decision=store.decision(taskId,versionId);result.set("decision",decision==null?NullNode.instance:decision);return result;});
    }
    public ObjectNode publish(TrustedContext actor,String command,String taskId,String runId,long expectedTask,long expectedReview){return write(actor,command,taskId,runId,expectedTask,expectedReview,"publish",null);}
    public ObjectNode decide(TrustedContext actor,String command,String taskId,String versionId,long expectedTask,long expectedReview,String decision,String comment){
        if(!Arrays.asList("approve","reject").contains(decision))throw fault(ErrorCode.INVALID_PAYLOAD);
        if("reject".equals(decision))comment=text(comment);else if(comment!=null)throw fault(ErrorCode.INVALID_PAYLOAD);
        return write(actor,command,taskId,versionId,expectedTask,expectedReview,decision,comment);
    }
    private ObjectNode write(TrustedContext actor,String command,String taskId,String target,long expectedTask,long expectedReview,String operation,String comment){
        actor(actor);id(command);id(taskId);id(target);version(expectedTask,1);version(expectedReview,0);
        ObjectNode payload=object().put("operation",operation).put("taskId",taskId).put("target",target).put("expectedTaskVersion",expectedTask).put("expectedReviewVersion",expectedReview);payload.put("comment",comment);byte[] hash=fingerprint(payload);
        return transaction(actor,true,(c,db,tasks,store,eventHead)->{
            JdbcTextDeliveryStore.Command previous=store.command(actor.principalId,command);
            if(previous!=null){task(db,tasks,actor,previous.task);if(!MessageDigest.isEqual(hash,previous.fingerprint))throw fault(ErrorCode.COMMAND_CONFLICT);return previous.receipt;}
            Task task=task(db,tasks,actor,taskId);if(store.expert(task.id))throw fault(ErrorCode.INPUT_CHANGED);ObjectNode h=head(store,task);long revision=h==null?0:h.path("revision").longValue();
            if(task.version!=expectedTask)throw new ApplicationFault(ErrorCode.VERSION_CONFLICT,task.version);
            if(revision!=expectedReview)throw fault(ErrorCode.VERSION_CONFLICT);if(revision>=JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
            ObjectNode receipt=object();long oldTaskVersion=task.version;String date=now(db);
            if("publish".equals(operation)){
                JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,actor.spaceId);Run run=runs.run(target);if(run==null)throw fault(ErrorCode.NOT_FOUND);
                if(!task.id.equals(run.taskId)||!task.groupId.equals(run.groupId)||!actor.principalId.equals(run.requesterPrincipalId))throw fault(ErrorCode.FORBIDDEN);
                Result result=runs.result(target);RequirementRunApplication.storedResult(run,result);
                if(run.status!=Status.SUCCEEDED||result==null||!"succeeded".equals(result.outcome)||task.status!=TaskStatus.ACTIVE||run.taskVersion!=task.version||!run.stageId.equals(task.currentStageId)||store.active(taskId,run.id))throw fault(ErrorCode.INPUT_CHANGED);
                Group g=group(db,actor,task.groupId);boolean bound=false;for(GroupBot b:g.bots)if(run.botId.equals(b.botId)&&run.botVersionId.equals(b.botVersionId))bound=true;if(!bound)throw fault(ErrorCode.INPUT_CHANGED);
                if(h!=null&&(!actor.principalId.equals(h.path("reviewerPrincipalId").textValue())||!run.botId.equals(h.path("botId").textValue())))throw fault(ErrorCode.FORBIDDEN);
                if(store.source(run.id)!=null)throw fault(ErrorCode.INPUT_CHANGED);
                ObjectNode input=input(c,run);long number=h==null?1:h.path("number").longValue()+1;if(number>JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
                ObjectNode v=object().put("id",uuid()).put("spaceId",task.spaceId).put("groupId",task.groupId).put("taskId",task.id).put("botId",run.botId).put("number",number).put("sourceRunId",run.id).put("sourceAttemptId",run.attemptId).put("inputTaskVersion",run.taskVersion).put("text",result.text).put("digest",digest(result.text)).put("sizeBytes",result.text.getBytes(StandardCharsets.UTF_8).length).put("createdAt",date).put("createdBy",actor.principalId);
                v.put("baseVersionId",input==null?null:input.path("versionId").textValue());v.put("feedbackMessageId",input==null?null:input.path("feedbackMessageId").textValue());store.version(v);
                h=object().put("spaceId",task.spaceId).put("groupId",task.groupId).put("taskId",task.id).put("botId",run.botId).put("revision",revision+1).put("versionId",v.path("id").textValue()).put("number",number).put("status","pending").put("reviewerPrincipalId",actor.principalId).putNull("feedbackMessageId").put("updatedAt",date);
                shape(task,"awaiting_business");receipt.put("versionId",v.path("id").textValue());receipt.putNull("decision");
            }else{
                if(h==null||!actor.principalId.equals(h.path("reviewerPrincipalId").textValue()))throw fault(ErrorCode.FORBIDDEN);
                if(!target.equals(h.path("versionId").textValue())||!"pending".equals(h.path("status").textValue())||task.status!=TaskStatus.AWAITING_BUSINESS||store.active(taskId,null))throw fault(ErrorCode.INPUT_CHANGED);
                ObjectNode v=delivery(store,task,target);if(!v.path("createdBy").textValue().equals(actor.principalId)||!v.path("botId").equals(h.path("botId")))throw fault(ErrorCode.FORBIDDEN);
                ObjectNode decision=object().put("id",uuid()).put("spaceId",task.spaceId).put("taskId",task.id).put("versionId",target).put("principalId",actor.principalId).put("decision",operation).put("comment",comment).put("createdAt",date).putNull("feedbackMessageId").put("taskVersion",oldTaskVersion+1);
                if("reject".equals(operation)){
                    TaskMessageResult message=new TaskMessageResult();message.taskVersion=oldTaskVersion+1;message.message=new TaskMessage();TaskMessage m=message.message;m.id=uuid();m.spaceId=task.spaceId;m.taskId=task.id;m.authorPrincipalId=actor.principalId;m.text=comment;m.artifactVersions=Collections.emptyList();m.createdAt=date;tasks.message(message,h.path("botId").textValue());decision.put("feedbackMessageId",m.id);h.put("feedbackMessageId",m.id);h.put("status","changes_requested");shape(task,"active");
                }else{h.put("status","completed");shape(task,"completed");}
                h.put("revision",revision+1).put("updatedAt",date);store.decision(decision);receipt.set("decision",decision);receipt.put("versionId",target);
            }
            next(task);task.updatedAt=date;tasks.advance(task,oldTaskVersion);observer.reached(TransactionObserver.Stage.VERSION_WRITTEN);store.head(h,revision);
            receipt.set("summary",summary(actor,task,h,store));store.command(actor.principalId,command,task.id,hash,receipt);tasks.internalEvent(task,actor.principalId,"publish".equals(operation)?"publishTextDelivery":"decideTextDelivery",eventHead,db.now());return receipt;
        });
    }
    /** Public TaskMessage shares the Task transaction and invalidates current review. */
    public static void message(Connection c,Task task,TaskMessageResult message)throws SQLException{
        if(task.status==TaskStatus.COMPLETED)throw fault(ErrorCode.INPUT_CHANGED);
        JdbcTextDeliveryStore store=new JdbcTextDeliveryStore(c,task.spaceId);ObjectNode h=head(store,task);if(h==null)return;
        if(store.active(task.id,null))throw fault(ErrorCode.INPUT_CHANGED);
        long revision=h.path("revision").longValue();if(revision>=JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
        h.put("revision",revision+1).put("status","invalidated").put("feedbackMessageId",message.message.id).put("updatedAt",message.message.createdAt);shape(task,"active");store.head(h,revision);
    }
    /** The queue marker prevents missing revision rows from falling back to legacy input. */
    public static ObjectNode input(Connection c,Run run)throws SQLException {
        JdbcTextDeliveryStore store=new JdbcTextDeliveryStore(c,run.spaceId);ObjectNode saved=store.input(run.id);
        if(run.deliveryVersionId==null){if(saved!=null)throw JdbcApplicationStore.corrupt();return null;}
        JdbcTaskStore tasks=new JdbcTaskStore(c,run.spaceId);Task task=tasks.task(run.taskId);ObjectNode h=head(store,task);
        if(saved==null||h==null||!run.deliveryVersionId.equals(h.path("versionId").textValue())||!run.requesterPrincipalId.equals(h.path("reviewerPrincipalId").textValue())||!run.botId.equals(h.path("botId").textValue()))throw JdbcApplicationStore.corrupt();
        ObjectNode v=delivery(store,task,run.deliveryVersionId);TaskMessageResult feedback=tasks.message(saved.path("feedbackMessageId").textValue());
        ObjectNode expected=revisionInput(run,v,feedback);
        Set<String> names=new HashSet<String>(),expectedNames=new HashSet<String>();saved.fieldNames().forEachRemaining(names::add);expected.fieldNames().forEachRemaining(expectedNames::add);if(!names.equals(expectedNames))throw JdbcApplicationStore.corrupt();
        for(String key:names)if(!saved.get(key).asText().equals(expected.get(key).asText())||saved.get(key).isNumber()!=expected.get(key).isNumber()||saved.get(key).isNumber()&&!saved.get(key).isIntegralNumber())throw JdbcApplicationStore.corrupt();
        if(feedback.taskVersion>run.taskVersion||!run.taskId.equals(feedback.message.taskId)||!h.path("feedbackMessageId").textValue().equals(feedback.message.id))throw JdbcApplicationStore.corrupt();return saved;
    }
    private static ObjectNode revisionInput(Run run,ObjectNode v,TaskMessageResult feedback){return object().put("runId",run.id).put("spaceId",run.spaceId).put("taskId",run.taskId).put("taskVersion",run.taskVersion).put("versionId",v.path("id").textValue()).put("number",v.path("number").longValue()).put("digest",v.path("digest").textValue()).put("text",v.path("text").textValue()).put("feedbackMessageId",feedback.message.id).put("feedbackText",feedback.message.text).put("feedbackTaskVersion",feedback.taskVersion);}
    /** Freeze one immutable base and its explicit feedback under the enqueue Task version. */
    public static void freeze(Connection c,Run run)throws SQLException{
        JdbcTextDeliveryStore store=new JdbcTextDeliveryStore(c,run.spaceId);JdbcTaskStore tasks=new JdbcTaskStore(c,run.spaceId);Task task=tasks.task(run.taskId);ObjectNode h=head(store,task);if(h==null)return;
        if(!run.requesterPrincipalId.equals(h.path("reviewerPrincipalId").textValue())||!run.botId.equals(h.path("botId").textValue()))throw fault(ErrorCode.FORBIDDEN);
        if(!Arrays.asList("invalidated","changes_requested").contains(h.path("status").textValue())||h.path("feedbackMessageId").isNull())throw fault(ErrorCode.INPUT_CHANGED);
        ObjectNode v=delivery(store,task,h.path("versionId").textValue());TaskMessageResult feedback=tasks.message(h.path("feedbackMessageId").textValue());
        if(!run.taskId.equals(feedback.message.taskId)||feedback.taskVersion>run.taskVersion)throw JdbcApplicationStore.corrupt();
        ObjectNode input=revisionInput(run,v,feedback);store.input(run.id,run.taskId,input);
    }
}
