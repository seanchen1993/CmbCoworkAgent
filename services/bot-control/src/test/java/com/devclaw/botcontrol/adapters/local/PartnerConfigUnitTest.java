package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.CompatibilityProbe;
import com.devclaw.botcontrol.contracts.BotContracts.Capability;
import com.devclaw.botcontrol.ports.TrustedContext;
import com.fasterxml.jackson.databind.node.*;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PartnerConfigUnitTest {
    private ObjectNode config(boolean configure,boolean access)throws Exception{
        ObjectNode root=CompatibilityProbe.strictMapper().createObjectNode(),legacy=root.putObject("legacy");legacy.put("mode","local-dev");legacy.putObject("http").put("host","127.0.0.1").put("port",0);
        legacy.putObject("db").put("mode","local-dev").put("host","127.0.0.1").put("port",12345).put("schema","devclaw").put("user","devclaw_app").put("password",new String(new char[64]).replace('\0','a'));
        ObjectNode identity=legacy.putObject("identity"),principal=identity.putArray("principals").addObject().put("principalId","owner").put("active",true),space=principal.putArray("spaces").addObject().put("spaceId","A").put("member",true).put("canCreateBot",true).put("canCreateGroup",true);
        space.putArray("knowledgeRefs");space.putArray("repositoryRefs");space.putArray("skillAllowlist");ArrayNode caps=space.putArray("capabilityCeiling");if(configure)caps.add("requirements.analyze");identity.putArray("bearers").addObject().put("principalId","owner").put("token",new String(new char[64]).replace('\0','b'));
        root.putArray("nodes").addObject().put("spaceId","A").put("nodeId","node").put("ownerPrincipalId","owner").put("credential","dcn1_"+new String(new char[64]).replace('\0','c')).put("expiresAt",new java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.ofEpochMilli(System.currentTimeMillis()+60000)));
        ObjectNode grant=root.putArray("access").addObject().put("spaceId","A").put("principalId","owner");if(access)grant.putArray("capabilities").add("requirements.analyze");else grant.putArray("capabilities");grant.putArray("workspaceRefs").add("view");return root;
    }
    private PartnerLaunchConfig parse(ObjectNode node)throws Exception{return PartnerLaunchConfig.parse(CompatibilityProbe.strictMapper().writeValueAsBytes(node));}
    @Test void runtimeAllowlistIsIndependentFromConfigurationPermission()throws Exception{
        TrustedContext owner=new TrustedContext("A","owner");PartnerLaunchConfig runtime=parse(config(false,true));assertFalse(runtime.legacy.identity.mayConfigure(owner,Capability.REQUIREMENTS_ANALYZE));assertTrue(runtime.access.mayUseCapability(owner,Capability.REQUIREMENTS_ANALYZE));assertTrue(runtime.access.mayUseWorkspace(owner,"view"));assertFalse(runtime.access.mayUseWorkspace(owner,"unlisted"));assertFalse(runtime.access.mayUseCapability(new TrustedContext("B","owner"),Capability.REQUIREMENTS_ANALYZE));
        PartnerLaunchConfig configure=parse(config(true,false));assertTrue(configure.legacy.identity.mayConfigure(owner,Capability.REQUIREMENTS_ANALYZE));assertFalse(configure.access.mayUseCapability(owner,Capability.REQUIREMENTS_ANALYZE));
    }
    @Test void unknownFieldsDuplicateScopesAndOtherCapabilitiesFailClosed()throws Exception{
        ObjectNode n=config(true,true);n.put("unknown","SYNTHETIC_SECRET");assertThrows(IllegalArgumentException.class,()->parse(n));
        ObjectNode duplicate=config(true,true);((ArrayNode)duplicate.get("access")).add(duplicate.get("access").get(0).deepCopy());assertThrows(IllegalArgumentException.class,()->parse(duplicate));
        ObjectNode capability=config(true,true);((ArrayNode)capability.get("access").get(0).get("capabilities")).set(0,TextNode.valueOf("repository.read"));assertThrows(IllegalArgumentException.class,()->parse(capability));
    }
    @Test void nodeScopeAndCredentialNamespaceRemainIndependent()throws Exception{
        ObjectNode n=config(true,true);((ObjectNode)n.get("nodes").get(0)).put("spaceId","B");assertThrows(IllegalArgumentException.class,()->parse(n));
        ObjectNode namespace=config(true,true);((ObjectNode)namespace.get("nodes").get(0)).put("credential",new String(new char[64]).replace('\0','b'));assertThrows(IllegalArgumentException.class,()->parse(namespace));
        PartnerLaunchConfig valid=parse(config(true,true));assertNull(valid.legacy.identity.principalFor("Bearer dcn1_"+new String(new char[64]).replace('\0','c')));assertThrows(com.devclaw.botcontrol.domain.ApplicationFault.class,()->valid.credentials.authenticate("Bearer "+new String(new char[64]).replace('\0','b')));
    }
    @Test void datesUseExplicitMillisecondsUtcAndDoNotExposeConfig()throws Exception{
        assertThrows(IllegalArgumentException.class,()->PartnerLaunchConfig.instant("2026-10-12T00:00:00Z"));assertThrows(IllegalArgumentException.class,()->PartnerLaunchConfig.instant("2026-10-12T00:00:00.001+00:00"));assertEquals(Instant.parse("2026-10-12T00:00:00.001Z"),PartnerLaunchConfig.instant("2026-10-12T00:00:00.001Z"));assertEquals("PartnerLaunchConfig[redacted]",parse(config(true,true)).toString());
    }
}
