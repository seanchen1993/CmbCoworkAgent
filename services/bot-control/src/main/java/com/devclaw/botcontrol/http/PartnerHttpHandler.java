package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.adapters.local.*;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcTaskStore;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.util.*;
import java.util.concurrent.Semaphore;
import javax.servlet.http.*;
import javax.sql.DataSource;

/** Fixed development transport. User and node credentials never substitute for
 * one another; node/space/owner come ONLY from the authenticated Session. */
final class PartnerHttpHandler {
    static final String CONTROL="/api/bot/local/v1/control",NODE="/api/bot/local/v1/node";
    private final PartnerLaunchConfig config;private final RequirementRunApplication runs;private final RuntimeNodeApplication nodes;private final LocalAuthenticatedNodeAdapter adapter;
    private final Semaphore admission=new Semaphore(4);private final ObjectMapper json=CompatibilityProbe.strictMapper();private final ContractBoundary boundary=new ContractBoundary();
    PartnerHttpHandler(PartnerLaunchConfig config,DataSource source){
        this.config=config;nodes=new RuntimeNodeApplication(source,config.legacy.identity,config.access,TransactionObserver.NONE);runs=new RequirementRunApplication(source,config.legacy.identity,config.access,TransactionObserver.NONE);adapter=new LocalAuthenticatedNodeAdapter(config.credentials,nodes,runs);
        json.getFactory().setStreamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(16).maxStringLength(65536).maxNumberLength(128).build());
    }
    boolean accepts(String path){return path!=null&&path.startsWith("/api/bot/local/");}
    private static ApplicationFault fault(ErrorCode code){return new ApplicationFault(code);}
    static void exact(JsonNode n,String... names){Set<String> actual=new HashSet<String>();n.fieldNames().forEachRemaining(actual::add);if(!n.isObject()||!actual.equals(new HashSet<String>(Arrays.asList(names))))throw fault(ErrorCode.INVALID_PAYLOAD);}
    private static String text(JsonNode n,String key){JsonNode value=n.get(key);if(value==null||!value.isTextual())throw fault(ErrorCode.INVALID_PAYLOAD);return value.textValue();}
    private String id(JsonNode n,String key){try{return boundary.validateParameter("getBot","botId",text(n,key));}catch(ContractBoundary.Failure f){throw fault(f.category()==ContractBoundary.Category.SCHEMA_RESOURCE?ErrorCode.DEPENDENCY_UNAVAILABLE:ErrorCode.INVALID_PAYLOAD);}}
    private static long number(JsonNode n,String key,long minimum){JsonNode value=n.get(key);if(value==null||!value.isIntegralNumber()||!value.canConvertToLong()||value.longValue()<minimum||value.longValue()>JdbcTaskStore.MAX)throw fault(ErrorCode.INVALID_PAYLOAD);return value.longValue();}
    private static java.time.Instant date(JsonNode n,String key){try{return PartnerLaunchConfig.instant(text(n,key));}catch(Exception f){throw fault(ErrorCode.INVALID_PAYLOAD);}}
    private ObjectNode envelope(String key,Object value){ObjectNode n=json.createObjectNode();n.set(key,json.valueToTree(value));return n;}
    private Object node(JsonNode body,LocalNodeCredentialRegistry.Session session){
        String op=text(body,"operation");
        switch(op){
            case "identity":exact(body,"operation");return config.credentials.use(session,context->{if(!config.legacy.identity.activeMember(context.spaceId,context.ownerPrincipalId))throw fault(ErrorCode.FORBIDDEN);return json.createObjectNode().put("spaceId",context.spaceId).put("nodeId",context.nodeId).put("ownerPrincipalId",context.ownerPrincipalId);});
            case "observe":exact(body,"operation");adapter.observe(session,true,Collections.singleton(Capability.REQUIREMENTS_ANALYZE));return json.createObjectNode().put("observed",true);
            case "poll":exact(body,"operation");return envelope("runs",adapter.poll(session));
            case "claim":exact(body,"operation","runId");return envelope("run",adapter.claim(session,id(body,"runId")));
            case "inspect":exact(body,"operation","runId");return adapter.inspect(session,id(body,"runId"));
            case "start":case "renew":exact(body,"operation","runId","attemptId","leaseId","fence");String run=id(body,"runId"),attempt=id(body,"attemptId"),lease=id(body,"leaseId");long fence=number(body,"fence",1);return op.equals("start")?adapter.start(session,run,attempt,lease,fence):envelope("run",adapter.renew(session,run,attempt,lease,fence));
            case "settle":exact(body,"operation","runId","attemptId","leaseId","fence","outcome","text");return envelope("result",adapter.settle(session,id(body,"runId"),id(body,"attemptId"),id(body,"leaseId"),number(body,"fence",1),text(body,"outcome"),text(body,"text")));
            default:throw fault(ErrorCode.INVALID_PAYLOAD);
        }
    }
    private Object control(JsonNode body,TrustedContext actor){
        String op=text(body,"operation");switch(op){
            case "identity":exact(body,"operation");return json.createObjectNode().put("spaceId",actor.spaceId).put("principalId",actor.principalId);
            case "authorization":exact(body,"operation","groupId");return envelope("grant",nodes.getRequirementNodeAuthorization(actor,id(body,"groupId")));
            case "authorize":exact(body,"operation","groupId","nodeId","workspaceRef","expectedVersion","expiresAt");return envelope("grant",nodes.authorizeRequirementNode(actor,id(body,"groupId"),id(body,"nodeId"),id(body,"workspaceRef"),number(body,"expectedVersion",0),date(body,"expiresAt")));
            case "revoke":exact(body,"operation","groupId","expectedVersion");return envelope("grant",nodes.revokeRequirementNode(actor,id(body,"groupId"),number(body,"expectedVersion",0)));
            case "enqueue":exact(body,"operation","commandId","taskId","botId","expectedTaskVersion","deadline");return runs.enqueueRequirement(actor,id(body,"commandId"),id(body,"taskId"),id(body,"botId"),number(body,"expectedTaskVersion",1),date(body,"deadline"));
            case "inspect":exact(body,"operation","runId");return runs.inspectRequirementRun(actor,id(body,"runId"));
            case "cancelPending":exact(body,"operation","runId","expectedVersion");return envelope("run",runs.cancelPendingRequirementRun(actor,id(body,"runId"),number(body,"expectedVersion",1)));
            case "lookupTaskNumber":exact(body,"operation","groupId","taskNumber");return envelope("task",runs.lookupTaskNumber(actor,id(body,"groupId"),text(body,"taskNumber")));
            default:throw fault(ErrorCode.INVALID_PAYLOAD);
        }
    }
    void handle(HttpServletRequest request,HttpServletResponse response)throws IOException{
        if(!admission.tryAcquire()){writeError(response,ErrorCode.RATE_LIMITED);return;}
        try{
            String path=request.getRequestURI();if(!"POST".equals(request.getMethod())||!Arrays.asList(CONTROL,NODE).contains(path)||request.getQueryString()!=null)throw fault(ErrorCode.INVALID_PAYLOAD);
            if(!"127.0.0.1".equals(request.getLocalAddr())||!"127.0.0.1".equals(request.getRemoteAddr())||!("127.0.0.1:"+request.getLocalPort()).equals(RawRequestGate.one(request,"Host",ErrorCode.INVALID_PAYLOAD)))throw fault(ErrorCode.INVALID_PAYLOAD);
            for(String h:Arrays.asList("Origin","Cookie","Cookie2","Content-Encoding","Proxy-Authorization"))if(request.getHeaders(h).hasMoreElements())throw fault(ErrorCode.INVALID_PAYLOAD);
            String auth=RawRequestGate.one(request,"Authorization",ErrorCode.UNAUTHENTICATED);LocalNodeCredentialRegistry.Session session=null;TrustedContext actor=null;
            if(NODE.equals(path)){if(request.getHeaders("X-DevClaw-Space").hasMoreElements())throw fault(ErrorCode.INVALID_PAYLOAD);session=adapter.authenticate(auth);}
            else{String principal=config.legacy.identity.principalFor(auth);if(principal==null)throw fault(ErrorCode.UNAUTHENTICATED);String space=RawRequestGate.one(request,"X-DevClaw-Space",ErrorCode.INVALID_PAYLOAD);try{boundary.validateParameter("getBot","X-DevClaw-Space",space);}catch(ContractBoundary.Failure f){throw fault(ErrorCode.INVALID_PAYLOAD);}if(!config.legacy.identity.activeMember(space,principal))throw fault(ErrorCode.FORBIDDEN);actor=new TrustedContext(space,principal);}
            if(!RawRequestGate.one(request,"Content-Type",ErrorCode.INVALID_PAYLOAD).matches("(?i)application/json(?:[ \\t]*;[ \\t]*charset[ \\t]*=[ \\t]*UTF-8)?"))throw fault(ErrorCode.INVALID_PAYLOAD);
            byte[] bytes=BoundedBody.read(request.getInputStream(),Operation.CREATE_BOT);String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();JsonNode body=json.readTree(text);if(body==null||!body.isObject())throw fault(ErrorCode.INVALID_PAYLOAD);
            Object value=NODE.equals(path)?node(body,session):control(body,actor);HttpOutput.write(response,new ApplicationResponse(200,json.writeValueAsBytes(value)));
        }catch(ApplicationFault f){writeError(response,f.code);}catch(HttpFailure f){writeError(response,f.code);}catch(CharacterCodingException|com.fasterxml.jackson.core.JsonProcessingException f){writeError(response,ErrorCode.INVALID_PAYLOAD);}catch(RuntimeException f){writeError(response,ErrorCode.DEPENDENCY_UNAVAILABLE);}finally{admission.release();}
    }
    private void writeError(HttpServletResponse response,ErrorCode code)throws IOException{
        int status;switch(code){case INVALID_PAYLOAD:case SCHEMA_VERSION_UNSUPPORTED:status=400;break;case UNAUTHENTICATED:status=401;break;case FORBIDDEN:status=403;break;case NOT_FOUND:status=404;break;case PAYLOAD_TOO_LARGE:status=413;break;case RATE_LIMITED:status=429;break;case DEPENDENCY_UNAVAILABLE:status=503;break;default:status=409;}
        response.setHeader("Connection","close");HttpOutput.write(response,new ApplicationResponse(status,json.writeValueAsBytes(json.createObjectNode().put("code",code.wire()))));
    }
}
