package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.Capability;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.*;
import java.time.*;
import java.util.*;
import static com.devclaw.botcontrol.adapters.local.LocalLaunchConfig.*;

/** Opt-in private development configuration, separate from the legacy main.
 * Trusted stdin only. Access is explicit runtime policy, never mayConfigure. */
public final class PartnerLaunchConfig {
    public final LocalLaunchConfig legacy;
    public final LocalNodeCredentialRegistry credentials;
    public final RuntimeAccessPolicy access;
    private PartnerLaunchConfig(LocalLaunchConfig legacy,LocalNodeCredentialRegistry credentials,RuntimeAccessPolicy access){this.legacy=legacy;this.credentials=credentials;this.access=access;}
    private static String id(JsonNode node){return new ContractBoundary().validateParameter("getBot","botId",string(node));}
    public static Instant instant(String text){
        if(text==null||!text.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z"))throw invalid();return Instant.parse(text);
    }
    public static PartnerLaunchConfig read(InputStream input){
        try{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buffer=new byte[4096];for(int n;(n=input.read(buffer))!=-1;){if(out.size()+n>MAX_BYTES)throw invalid();out.write(buffer,0,n);}return parse(out.toByteArray());}catch(Exception failure){throw invalid();}
    }
    public static PartnerLaunchConfig parse(byte[] bytes){
        try{
            if(bytes==null||bytes.length==0||bytes.length>MAX_BYTES)throw invalid();
            String text=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            ObjectMapper mapper=CompatibilityProbe.strictMapper();mapper.getFactory().setStreamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(16).maxStringLength(4096).maxNumberLength(128).build());
            JsonNode root=mapper.readTree(text);fields(root,"legacy","nodes","access");LocalLaunchConfig legacy=LocalLaunchConfig.parse(mapper.writeValueAsBytes(root.get("legacy")));
            array(root.get("nodes"),16);List<LocalNodeCredentialRegistry.Binding> bindings=new ArrayList<LocalNodeCredentialRegistry.Binding>();
            for(JsonNode n:root.get("nodes")){fields(n,"spaceId","nodeId","ownerPrincipalId","credential","expiresAt");String space=id(n.get("spaceId")),owner=id(n.get("ownerPrincipalId"));if(!legacy.identity.activeMember(space,owner))throw invalid();bindings.add(new LocalNodeCredentialRegistry.Binding(space,id(n.get("nodeId")),owner,string(n.get("credential")),instant(string(n.get("expiresAt")))));}
            LocalNodeCredentialRegistry credentials=new LocalNodeCredentialRegistry(Clock.systemUTC(),bindings);
            array(root.get("access"),32);Map<List<String>,Set<String>> workspaces=new HashMap<List<String>,Set<String>>();Set<List<String>> capabilities=new HashSet<List<String>>();
            for(JsonNode a:root.get("access")){
                fields(a,"spaceId","principalId","capabilities","workspaceRefs");String space=id(a.get("spaceId")),principal=id(a.get("principalId"));if(!legacy.identity.activeMember(space,principal))throw invalid();List<String> key=Arrays.asList(space,principal);
                array(a.get("capabilities"),1);boolean allowed=false;for(JsonNode cap:a.get("capabilities")){if(!Capability.REQUIREMENTS_ANALYZE.wire().equals(string(cap))||allowed)throw invalid();allowed=true;}
                array(a.get("workspaceRefs"),64);Set<String> refs=new HashSet<String>();for(JsonNode ref:a.get("workspaceRefs"))if(!refs.add(id(ref)))throw invalid();
                if(workspaces.put(key,Collections.unmodifiableSet(refs))!=null)throw invalid();if(allowed)capabilities.add(key);
            }
            final Map<List<String>,Set<String>> scopes=Collections.unmodifiableMap(workspaces);final Set<List<String>> allowed=Collections.unmodifiableSet(capabilities);
            RuntimeAccessPolicy access=new RuntimeAccessPolicy(){
                private List<String> key(TrustedContext actor){return actor!=null&&legacy.identity.activeMember(actor.spaceId,actor.principalId)?Arrays.asList(actor.spaceId,actor.principalId):null;}
                public boolean mayUseCapability(TrustedContext actor,Capability cap){return cap==Capability.REQUIREMENTS_ANALYZE&&allowed.contains(key(actor));}
                public boolean mayUseWorkspace(TrustedContext actor,String ref){Set<String> refs=scopes.get(key(actor));return refs!=null&&refs.contains(ref);}
            };
            return new PartnerLaunchConfig(legacy,credentials,access);
        }catch(Exception failure){throw invalid();}
    }
    @Override public String toString(){return "PartnerLaunchConfig[redacted]";}
}
