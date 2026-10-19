package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.*;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.*;
import com.devclaw.botcontrol.persistence.JdbcExpertConversationStore.Conversation;
import com.devclaw.botcontrol.ports.*;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import javax.sql.DataSource;

/** Narrow text conversations. Model output never supplies authority or mutation material. */
public final class ExpertConversationApplication {
    private static final ObjectMapper JSON=CompatibilityProbe.strictMapper();
    private final DataSource source;private final IdentityPolicy identity;private final TransactionObserver observer;
    public ExpertConversationApplication(DataSource source,IdentityPolicy identity,TransactionObserver observer){this.source=source;this.identity=identity;this.observer=observer;}
    private static ApplicationFault fault(ErrorCode code){return new ApplicationFault(code);}
    private static String id(String value){return GroupMemoryValues.id(value);}
    private static String text(String value,int maximum){
        if(value==null||value.trim().isEmpty()||value.codePointCount(0,value.length())>maximum)throw fault(ErrorCode.INVALID_PAYLOAD);
        for(int i=0;i<value.length();i++){char ch=value.charAt(i);if(Character.isHighSurrogate(ch)){if(++i>=value.length()||!Character.isLowSurrogate(value.charAt(i)))throw fault(ErrorCode.INVALID_PAYLOAD);}else if(ch==0||Character.isLowSurrogate(ch))throw fault(ErrorCode.INVALID_PAYLOAD);}return value;
    }
    private static void exact(JsonNode value,String... keys){Set<String> actual=new HashSet<String>();value.fieldNames().forEachRemaining(actual::add);if(!value.isObject()||!actual.equals(new HashSet<String>(Arrays.asList(keys))))throw fault(ErrorCode.INVALID_PAYLOAD);}
    private static ObjectNode object(){return JSON.createObjectNode();}
    private static String uuid(){return UUID.randomUUID().toString();}
    private static byte[] hash(JsonNode value){try{return MessageDigest.getInstance("SHA-256").digest(JdbcApplicationStore.json(value));}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private static String digest(JsonNode value){StringBuilder result=new StringBuilder("sha256:");for(byte b:hash(value))result.append(String.format(Locale.ROOT,"%02x",b&255));return result.toString();}
    private static ObjectNode parse(byte[] bytes){try{JsonNode value=JSON.readTree(bytes);if(!value.isObject())throw JdbcApplicationStore.corrupt();return (ObjectNode)value;}catch(Exception failure){throw JdbcApplicationStore.corrupt();}}
    private void actor(TrustedContext actor){if(actor==null)throw fault(ErrorCode.UNAUTHENTICATED);id(actor.spaceId);id(actor.principalId);if(!identity.activeMember(actor.spaceId,actor.principalId))throw fault(ErrorCode.FORBIDDEN);}
    private interface Work<T>{T run(Connection c,JdbcApplicationStore db,JdbcTaskStore tasks,JdbcExpertConversationStore store,long eventHead)throws SQLException;}
    private <T>T transaction(TrustedContext actor,boolean write,Work<T> work){actor(actor);boolean attempted=false;
        try(Connection c=source.getConnection()){c.setTransactionIsolation(Connection.TRANSACTION_READ_COMMITTED);c.setAutoCommit(false);
            try{JdbcApplicationStore db=new JdbcApplicationStore(c,actor.spaceId,observer);JdbcTaskStore tasks=new JdbcTaskStore(c,actor.spaceId);if(write)db.lockScope(actor.principalId);long head=write?tasks.lockHead():0;
                T result=work.run(c,db,tasks,new JdbcExpertConversationStore(c,actor.spaceId),head);if(write)observer.reached(TransactionObserver.Stage.BEFORE_COMMIT);attempted=true;c.commit();if(write)observer.reached(TransactionObserver.Stage.AFTER_COMMIT);return result;
            }catch(SQLException|RuntimeException failure){if(!attempted)try{c.rollback();}catch(SQLException ignored){}if(attempted&&write)throw fault(ErrorCode.OUTCOME_UNKNOWN);if(failure instanceof ApplicationFault)throw (ApplicationFault)failure;throw JdbcApplicationStore.corrupt();}
        }catch(SQLException failure){throw fault(attempted&&write?ErrorCode.OUTCOME_UNKNOWN:ErrorCode.DEPENDENCY_UNAVAILABLE);}
    }
    private static Group group(JdbcApplicationStore db,TrustedContext actor,String groupId,String botId)throws SQLException {
        Group group=db.group(groupId);if(group==null)throw fault(ErrorCode.NOT_FOUND);if(!ReceiptAccess.member(actor,group,false))throw fault(ErrorCode.FORBIDDEN);
        if(botId!=null){boolean found=false;for(GroupBot binding:group.bots)if(botId.equals(binding.botId))found=true;if(!found)throw fault(ErrorCode.FORBIDDEN);}return group;
    }
    private static Task task(JdbcApplicationStore db,JdbcTaskStore tasks,TrustedContext actor,String taskId)throws SQLException {
        String groupId=tasks.groupId(taskId);if(groupId==null)throw fault(ErrorCode.NOT_FOUND);group(db,actor,groupId,null);Task task=tasks.task(taskId);if(task==null||!groupId.equals(task.groupId))throw JdbcApplicationStore.corrupt();return task;
    }
    private static Conversation owner(JdbcExpertConversationStore store,Task task,TrustedContext actor)throws SQLException {
        Conversation conversation=store.conversation(task.id);if(conversation==null)throw fault(ErrorCode.INPUT_CHANGED);
        if(!task.groupId.equals(conversation.groupId)||!actor.principalId.equals(conversation.principalId))throw fault(ErrorCode.FORBIDDEN);return conversation;
    }
    private static ObjectNode receipt(Task task,Conversation conversation,String sourceRun,String message){ObjectNode r=object();r.set("task",JSON.valueToTree(task));r.put("role",conversation.role).put("botId",conversation.botId).put("principalId",conversation.principalId).put("sourceRunId",sourceRun).put("messageId",message);return r;}
    private static ObjectNode replay(JdbcExpertConversationStore.Command command,byte[] fingerprint,JdbcApplicationStore db,JdbcTaskStore tasks,TrustedContext actor)throws SQLException {
        if(command==null)return null;Task task=task(db,tasks,actor,command.taskId);group(db,actor,task.groupId,command.receipt.path("botId").textValue());if(!MessageDigest.isEqual(fingerprint,command.fingerprint))throw fault(ErrorCode.COMMAND_CONFLICT);return command.receipt;
    }
    private static Task create(JdbcTaskStore tasks,TrustedContext actor,String group,String title,String goal,String now)throws SQLException {
        Task task=new Task();task.id=uuid();task.spaceId=actor.spaceId;task.groupId=group;task.version=1L;task.taskNumber=tasks.nextNumber();task.title=title;task.goal=goal;task.status=TaskStatus.ACTIVE;task.createdAt=task.updatedAt=now;task.inputArtifactVersions=Collections.emptyList();task.stages=new ArrayList<Stage>();
        for(StageKind kind:StageKind.values()){Stage stage=new Stage();stage.id=uuid();stage.kind=kind;stage.status=task.stages.isEmpty()?StageStatus.ACTIVE:StageStatus.PENDING;stage.inputArtifactVersions=stage.outputArtifactVersions=Collections.emptyList();task.stages.add(stage);}task.currentStageId=task.stages.get(0).id;tasks.create(task);return task;
    }
    private static void advance(Task task,JdbcTaskStore tasks,long head,TrustedContext actor,String operation,String now)throws SQLException {
        long old=task.version;if(old>=JdbcTaskStore.MAX)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);task.version++;task.updatedAt=now;tasks.advance(task,old);tasks.internalEvent(task,actor.principalId,operation,head,Timestamp.from(java.time.Instant.parse(now)));
    }
    private static void idle(Connection c,Task task)throws SQLException {if(new JdbcTextDeliveryStore(c,task.spaceId).active(task.id,null))throw fault(ErrorCode.INPUT_CHANGED);}
    public ObjectNode identity(TrustedContext actor){return transaction(actor,false,(c,db,tasks,store,head)->object().put("instanceId",store.instanceId()).put("spaceId",actor.spaceId).put("principalId",actor.principalId));}
    public ObjectNode ensure(TrustedContext actor,String command,String groupId,String botId,String role,String existing,String title,String goal){
        id(command);id(groupId);id(botId);if(!Arrays.asList("main","task").contains(role))throw fault(ErrorCode.INVALID_PAYLOAD);if(existing!=null)id(existing);text(title,160);text(goal,16384);
        ObjectNode payload=object().put("operation","ensure").put("groupId",groupId).put("botId",botId).put("role",role).put("taskId",existing).put("title",title).put("goal",goal);byte[] fingerprint=hash(payload);
        return transaction(actor,true,(c,db,tasks,store,head)->{
            group(db,actor,groupId,botId);ObjectNode old=replay(store.command(actor.principalId,command),fingerprint,db,tasks,actor);if(old!=null)return old;
            String taskId=existing!=null?existing:"main".equals(role)?store.main(groupId,botId,actor.principalId):null;Task task;
            if(taskId!=null){task=task(db,tasks,actor,taskId);if(!groupId.equals(task.groupId))throw fault(ErrorCode.FORBIDDEN);Conversation current=store.conversation(taskId);
                if(current==null){if(!"task".equals(role)||!actor.principalId.equals(store.originalRequester(taskId,botId)))throw fault(ErrorCode.FORBIDDEN);idle(c,task);store.conversation(task.id,groupId,botId,actor.principalId,role,JSON.createArrayNode());}
                else if(!role.equals(current.role)||!botId.equals(current.botId)||!actor.principalId.equals(current.principalId))throw fault(ErrorCode.FORBIDDEN);
            }else{task=create(tasks,actor,groupId,title,goal,JdbcApplicationStore.text(db.now()));store.conversation(task.id,groupId,botId,actor.principalId,role,JSON.createArrayNode());tasks.internalEvent(task,actor.principalId,"ensureExpertConversation",head,db.now());}
            ObjectNode result=receipt(task,owner(store,task,actor),null,null);store.command(actor.principalId,command,"ensure",fingerprint,result);return result;
        });
    }
    public ObjectNode summaries(TrustedContext actor,String groupId,String botId,List<String> ids){id(groupId);id(botId);if(ids==null||ids.isEmpty()||ids.size()>40||new HashSet<String>(ids).size()!=ids.size())throw fault(ErrorCode.INVALID_PAYLOAD);for(String id:ids)id(id);
        return transaction(actor,false,(c,db,tasks,store,head)->{
            group(db,actor,groupId,botId);Map<String,JdbcTaskStore.Summary> values=tasks.summaries(groupId,ids);Map<String,Conversation> conversations=store.conversations(ids);Set<String> busy=store.busy(ids);Map<String,String> legacy=store.originalRequesters(groupId,ids,botId);ArrayNode items=JSON.createArrayNode();
            for(JdbcTaskStore.Summary task:values.values()){
                Conversation conversation=conversations.get(task.id);if(conversation==null&&!actor.principalId.equals(legacy.get(task.id)))throw fault(ErrorCode.FORBIDDEN);if(!groupId.equals(task.groupId)||conversation!=null&&(!groupId.equals(conversation.groupId)||!botId.equals(conversation.botId)||!actor.principalId.equals(conversation.principalId)))throw fault(ErrorCode.FORBIDDEN);
                items.add(object().put("taskId",task.id).put("taskVersion",task.version).put("status",task.status).put("role",conversation==null?"task":conversation.role).put("busy",busy.contains(task.id)));
            }ObjectNode result=object();result.set("items",items);return result;
        });
    }
    public ObjectNode lifecycle(TrustedContext actor,String command,String taskId,long expected,String action){
        id(command);id(taskId);GroupMemoryValues.version(expected,1);if(!Arrays.asList("complete","reopen").contains(action))throw fault(ErrorCode.INVALID_PAYLOAD);ObjectNode payload=object().put("operation",action).put("taskId",taskId).put("expectedVersion",expected);byte[] fingerprint=hash(payload);
        return transaction(actor,true,(c,db,tasks,store,head)->{ObjectNode old=replay(store.command(actor.principalId,command),fingerprint,db,tasks,actor);if(old!=null)return old;Task task=task(db,tasks,actor,taskId);Conversation conversation=owner(store,task,actor);group(db,actor,task.groupId,conversation.botId);if(!"task".equals(conversation.role))throw fault(ErrorCode.FORBIDDEN);if(task.version!=expected)throw fault(ErrorCode.VERSION_CONFLICT);idle(c,task);
            if("complete".equals(action)){if(!Arrays.asList(TaskStatus.ACTIVE,TaskStatus.AWAITING_BUSINESS).contains(task.status))throw fault(ErrorCode.INPUT_CHANGED);TextDeliveryApplication.shape(task,"completed");}
            else{if(task.status!=TaskStatus.COMPLETED)throw fault(ErrorCode.INPUT_CHANGED);TextDeliveryApplication.shape(task,"active");}
            advance(task,tasks,head,actor,"expertTask"+action,JdbcApplicationStore.text(db.now()));ObjectNode result=receipt(task,conversation,null,null);store.command(actor.principalId,command,action,fingerprint,result);return result;});
    }
    private static ObjectNode contextMessage(String role,String value,String source,long version){return object().put("role",role).put("text",value).put("sourceId",source).put("taskVersion",version);}
    private static void frozen(ObjectNode body){
        try{
            exact(body,"profile","taskId","taskVersion","sourceRequestId","messages","targets","digest");id(body.path("taskId").textValue());id(body.path("sourceRequestId").textValue());
            if(!Arrays.asList("expert_main_v1","expert_task_v1").contains(body.path("profile").textValue())||!body.path("taskVersion").isIntegralNumber())throw JdbcApplicationStore.corrupt();GroupMemoryValues.version(body.path("taskVersion").longValue(),1);
            JsonNode messages=body.path("messages"),targets=body.path("targets");if(!messages.isArray()||messages.size()<1||messages.size()>412||!targets.isArray()||targets.size()>40||"expert_task_v1".equals(body.path("profile").textValue())&&targets.size()!=0)throw JdbcApplicationStore.corrupt();
            for(JsonNode entry:messages){exact(entry,"role","text","sourceId","taskVersion");if(!Arrays.asList("user","assistant").contains(entry.path("role").textValue())||!entry.path("taskVersion").isIntegralNumber())throw JdbcApplicationStore.corrupt();text(entry.path("text").textValue(),16384);id(entry.path("sourceId").textValue());GroupMemoryValues.version(entry.path("taskVersion").longValue(),1);}
            Set<String> ids=new HashSet<String>();for(JsonNode target:targets){exact(target,"taskId","title","status");if(!ids.add(id(target.path("taskId").textValue()))||!Arrays.asList("active","awaiting_business","completed").contains(target.path("status").textValue()))throw JdbcApplicationStore.corrupt();text(target.path("title").textValue(),160);}
            ObjectNode unsigned=body.deepCopy();unsigned.remove("digest");if(JdbcApplicationStore.json(unsigned).length>60000||!digest(unsigned).equals(body.path("digest").textValue()))throw JdbcApplicationStore.corrupt();
        }catch(ApplicationFault failure){throw JdbcApplicationStore.corrupt();}
    }
    public ObjectNode freeze(TrustedContext actor,String command,String taskId,long expected,String requestId,List<String> allowed){
        id(command);id(taskId);id(requestId);GroupMemoryValues.version(expected,1);if(allowed==null||allowed.size()>40||new HashSet<String>(allowed).size()!=allowed.size())throw fault(ErrorCode.INVALID_PAYLOAD);for(String target:allowed)id(target);
        ObjectNode payload=object().put("taskId",taskId).put("taskVersion",expected).put("sourceRequestId",requestId);payload.set("allowed",JSON.valueToTree(allowed));byte[] fingerprint=hash(payload);
        return transaction(actor,true,(c,db,tasks,store,head)->{Task task=task(db,tasks,actor,taskId);Conversation conversation=owner(store,task,actor);group(db,actor,task.groupId,conversation.botId);JdbcExpertConversationStore.Input previous=store.input(actor.principalId,command);if(previous!=null){if(!MessageDigest.isEqual(previous.fingerprint,fingerprint))throw fault(ErrorCode.COMMAND_CONFLICT);frozen(previous.body);return previous.body;}
            if(task.version!=expected)throw fault(ErrorCode.VERSION_CONFLICT);if(task.status!=TaskStatus.ACTIVE)throw fault(ErrorCode.INPUT_CHANGED);idle(c,task);if(!"main".equals(conversation.role)&&!allowed.isEmpty())throw fault(ErrorCode.INVALID_PAYLOAD);
            ArrayNode messages=JSON.createArrayNode();for(JsonNode carried:conversation.carried)messages.add(carried);List<ObjectNode> local=new ArrayList<ObjectNode>();local.add(contextMessage("user",task.goal,task.id,1));
            for(TaskMessageResult message:store.messages(taskId,expected,conversation.botId))local.add(contextMessage("user",message.message.text,message.message.id,message.taskVersion));
            for(HistoryResult result:new JdbcRequirementRunStore(c,actor.spaceId).history(taskId,expected,conversation.botId)){
                RequirementRunApplication.storedResult(result.run,result.result);if(!conversation.botId.equals(result.run.botId))continue;String value=result.result.text;
                if("expert_main_v1".equals(result.run.executionProfile)){
                    ObjectNode envelope;try{envelope=envelope(value);}catch(ApplicationFault invalid){if(invalid.code!=ErrorCode.INVALID_PAYLOAD)throw invalid;envelope=object().put("reply","该轮回复无法解析，未交办。").putNull("intent");}if(envelope.path("intent").isNull())value=envelope.path("reply").textValue();
                    else if(result.coordinationReceipt==null)value="本轮提出任务交办或转达，尚未送达。";
                    else{ObjectNode saved=parse(result.coordinationReceipt);if(!result.run.id.equals(saved.path("sourceRunId").textValue())||!actor.principalId.equals(saved.path("principalId").textValue())||!task.groupId.equals(saved.path("task").path("groupId").textValue()))throw JdbcApplicationStore.corrupt();value="已送达任务："+saved.path("task").path("title").asText();}
                }
                local.add(contextMessage("assistant",value,result.run.id,result.run.taskVersion));
            }
            Collections.sort(local,(a,b)->{int version=Long.compare(a.path("taskVersion").longValue(),b.path("taskVersion").longValue());return version!=0?version:a.path("role").asText().equals(b.path("role").asText())?a.path("sourceId").asText().compareTo(b.path("sourceId").asText()):"user".equals(a.path("role").asText())?-1:1;});for(ObjectNode message:local)messages.add(message);
            ArrayNode targets=JSON.createArrayNode();List<String> sorted=new ArrayList<String>(allowed);Collections.sort(sorted);Map<String,JdbcTaskStore.Summary> summaries=tasks.summaries(task.groupId,sorted);Map<String,Conversation> entries=store.conversations(sorted);Map<String,String> legacy=store.originalRequesters(task.groupId,sorted,conversation.botId);
            for(JdbcTaskStore.Summary target:summaries.values()){Conversation entry=entries.get(target.id);if(!task.groupId.equals(target.groupId)||(entry==null?!actor.principalId.equals(legacy.get(target.id)):!actor.principalId.equals(entry.principalId)||!"task".equals(entry.role)||!conversation.botId.equals(entry.botId)||!task.groupId.equals(entry.groupId)))throw fault(ErrorCode.FORBIDDEN);targets.add(object().put("taskId",target.id).put("title",target.title).put("status",target.status));}
            ObjectNode body=object().put("profile","main".equals(conversation.role)?"expert_main_v1":"expert_task_v1").put("taskId",taskId).put("taskVersion",expected).put("sourceRequestId",requestId);body.set("messages",messages);body.set("targets",targets);
            // Explicit rejection, never silent removal of earlier instructions or answers.
            if(JdbcApplicationStore.json(body).length>60000)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);body.put("digest",digest(body));frozen(body);store.input(actor.principalId,command,fingerprint,body);return body;});
    }
    public static boolean attach(Connection c,Run run)throws SQLException {
        JdbcExpertConversationStore store=new JdbcExpertConversationStore(c,run.spaceId);Conversation conversation=store.conversation(run.taskId);JdbcExpertConversationStore.Input input=store.input(run.requesterPrincipalId,run.commandId);
        if(conversation==null){if(input!=null)throw JdbcApplicationStore.corrupt();return false;}
        if(input==null||!conversation.principalId.equals(run.requesterPrincipalId)||!conversation.botId.equals(run.botId)||!input.taskId.equals(run.taskId)||input.taskVersion!=run.taskVersion||input.runId!=null)throw fault(ErrorCode.INPUT_CHANGED);
        store.attach(run.requesterPrincipalId,run.commandId,run,input);return true;
    }
    public static ObjectNode input(Connection c,Run run)throws SQLException {
        JdbcExpertConversationStore store=new JdbcExpertConversationStore(c,run.spaceId);JdbcExpertConversationStore.Input input=store.runInput(run.id);
        if(run.executionProfile==null){if(input!=null||run.contextDigest!=null)throw JdbcApplicationStore.corrupt();return null;}
        if(input==null||!run.requesterPrincipalId.equals(input.principalId)||!run.commandId.equals(input.commandId)||!run.id.equals(input.runId)||!run.taskId.equals(input.taskId)||run.taskVersion!=input.taskVersion||!run.executionProfile.equals(input.profile)||!run.contextDigest.equals(input.digest))throw JdbcApplicationStore.corrupt();
        Conversation conversation=store.conversation(run.taskId);if(conversation==null||!conversation.principalId.equals(run.requesterPrincipalId)||!conversation.botId.equals(run.botId)||!run.groupId.equals(conversation.groupId))throw JdbcApplicationStore.corrupt();
        if(!input.profile.equals("main".equals(conversation.role)?"expert_main_v1":"expert_task_v1"))throw JdbcApplicationStore.corrupt();frozen(input.body);return input.body;
    }
    private static ObjectNode envelope(String text){ObjectNode value;try{value=(ObjectNode)JSON.readTree(text);}catch(Exception failure){throw fault(ErrorCode.INVALID_PAYLOAD);}if(value==null)throw fault(ErrorCode.INVALID_PAYLOAD);exact(value,"reply","intent");text(value.path("reply").textValue(),12000);JsonNode intent=value.path("intent");if(intent.isNull())return value;
        String kind=intent.path("kind").textValue();if("create_task".equals(kind)){exact(intent,"kind","sourceRequestId","title","contextSourceIds");text(intent.path("title").textValue(),160);JsonNode selected=intent.path("contextSourceIds");if(!selected.isArray()||selected.size()>12)throw fault(ErrorCode.INVALID_PAYLOAD);Set<String> ids=new HashSet<String>();for(JsonNode source:selected)if(!source.isTextual()||!ids.add(id(source.textValue())))throw fault(ErrorCode.INVALID_PAYLOAD);}else if("append_task".equals(kind)){exact(intent,"kind","sourceRequestId","targetTaskRef");id(intent.path("targetTaskRef").textValue());}else throw fault(ErrorCode.INVALID_PAYLOAD);id(intent.path("sourceRequestId").textValue());return value;
    }
    public ObjectNode coordinate(TrustedContext actor,String command,String sourceRunId){id(command);id(sourceRunId);ObjectNode payload=object().put("operation","coordinate").put("sourceRunId",sourceRunId);byte[] fingerprint=hash(payload);
        return transaction(actor,true,(c,db,tasks,store,head)->{
            ObjectNode old=replay(store.command(actor.principalId,command),fingerprint,db,tasks,actor);if(old!=null)return old;
            JdbcRequirementRunStore runs=new JdbcRequirementRunStore(c,actor.spaceId);String sourceGroup=runs.groupId(sourceRunId);if(sourceGroup==null)throw fault(ErrorCode.NOT_FOUND);group(db,actor,sourceGroup,null);Run run=runs.run(sourceRunId);Task main=task(db,tasks,actor,run.taskId);Conversation conversation=owner(store,main,actor);group(db,actor,main.groupId,conversation.botId);
            if(!"main".equals(conversation.role)||!"expert_main_v1".equals(run.executionProfile)||!actor.principalId.equals(run.requesterPrincipalId)||!conversation.botId.equals(run.botId))throw fault(ErrorCode.FORBIDDEN);
            JdbcExpertConversationStore.Command consumed=store.source(sourceRunId);if(consumed!=null){Task consumedTask=task(db,tasks,actor,consumed.taskId);group(db,actor,consumedTask.groupId,consumed.receipt.path("botId").textValue());if(!actor.principalId.equals(consumed.receipt.path("principalId").textValue())||!"coordinate".equals(consumed.operation)||!sourceRunId.equals(consumed.sourceRunId))throw JdbcApplicationStore.corrupt();if(!MessageDigest.isEqual(fingerprint,consumed.fingerprint))throw fault(ErrorCode.COMMAND_CONFLICT);return consumed.receipt;}
            Result result=runs.result(sourceRunId);RequirementRunApplication.storedResult(run,result);if(run.status!=Status.SUCCEEDED||result==null||main.version!=run.taskVersion)throw fault(ErrorCode.INPUT_CHANGED);
            ObjectNode input=input(c,run),envelope=envelope(result.text);JsonNode intent=envelope.path("intent");if(intent.isNull()||!input.path("sourceRequestId").textValue().equals(intent.path("sourceRequestId").textValue()))throw fault(ErrorCode.INVALID_PAYLOAD);
            JsonNode messages=input.path("messages");JsonNode last=null;for(JsonNode message:messages)if("user".equals(message.path("role").textValue()))last=message;if(last==null)throw JdbcApplicationStore.corrupt();String material=text(last.path("text").textValue(),16384);String now=JdbcApplicationStore.text(db.now());Task target;String messageId=null;
            if("create_task".equals(intent.path("kind").textValue())){
                ArrayNode carried=JSON.createArrayNode();Set<String> selected=new HashSet<String>();for(JsonNode ref:intent.path("contextSourceIds"))selected.add(ref.textValue());String currentSource=last.path("sourceId").textValue();if(selected.contains(currentSource))throw fault(ErrorCode.FORBIDDEN);for(JsonNode message:messages)if(selected.remove(message.path("sourceId").textValue()))carried.add(message);if(!selected.isEmpty())throw fault(ErrorCode.FORBIDDEN);if(JdbcApplicationStore.json(carried).length>24576)throw fault(ErrorCode.PAYLOAD_TOO_LARGE);
                target=create(tasks,actor,main.groupId,intent.path("title").textValue(),material,now);store.conversation(target.id,target.groupId,run.botId,actor.principalId,"task",carried);tasks.internalEvent(target,actor.principalId,"coordinateExpertTask",head,db.now());
            }else{
                String targetId=intent.path("targetTaskRef").textValue();boolean allowed=false;for(JsonNode entry:input.path("targets"))if(targetId.equals(entry.path("taskId").textValue()))allowed=true;if(!allowed)throw fault(ErrorCode.FORBIDDEN);
                target=task(db,tasks,actor,targetId);Conversation targetConversation=store.conversation(targetId);if(targetConversation==null){if(!actor.principalId.equals(store.originalRequester(targetId,run.botId)))throw fault(ErrorCode.FORBIDDEN);idle(c,target);store.conversation(target.id,target.groupId,run.botId,actor.principalId,"task",JSON.createArrayNode());targetConversation=owner(store,target,actor);}if(!"task".equals(targetConversation.role)||!run.botId.equals(targetConversation.botId)||!main.groupId.equals(target.groupId)||target.status!=TaskStatus.ACTIVE)throw fault(ErrorCode.INPUT_CHANGED);idle(c,target);
                TaskMessageResult feedback=new TaskMessageResult();feedback.taskVersion=target.version+1;feedback.message=new TaskMessage();TaskMessage m=feedback.message;m.id=uuid();m.spaceId=target.spaceId;m.taskId=target.id;m.authorPrincipalId=actor.principalId;m.text=material;m.artifactVersions=Collections.emptyList();m.createdAt=now;tasks.message(feedback,run.botId);messageId=m.id;advance(target,tasks,head,actor,"coordinateExpertMessage",now);
            }
            ObjectNode receipt=receipt(target,owner(store,target,actor),run.id,messageId);store.command(actor.principalId,command,"coordinate",fingerprint,receipt);return receipt;
        });
    }
    /** M04 messages share the public Task transaction; completed tasks require reopen. */
    public static boolean message(Connection c,Task task,TaskMessageResult message,String targetBot)throws SQLException {
        JdbcExpertConversationStore store=new JdbcExpertConversationStore(c,task.spaceId);Conversation conversation=store.conversation(task.id);if(conversation==null)return false;
        if(!conversation.principalId.equals(message.message.authorPrincipalId)||targetBot!=null&&!conversation.botId.equals(targetBot))throw fault(ErrorCode.FORBIDDEN);if(task.status==TaskStatus.COMPLETED)throw fault(ErrorCode.INPUT_CHANGED);idle(c,task);TextDeliveryApplication.shape(task,"active");return true;
    }
}
