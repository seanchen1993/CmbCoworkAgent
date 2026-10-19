package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.TransactionObserver;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ExpertConversationUnitTest {
    @Test void frozenUtf8MatchesJavascriptForNonBmpAndEscapes() throws Exception {
        com.fasterxml.jackson.databind.node.ObjectNode value=com.devclaw.botcontrol.CompatibilityProbe.strictMapper().createObjectNode();
        value.put("text","中文\uD83E\uDDED \" \\ literal\\uD83E \b \t \n \f \r \u000b \u001f \u2028 \u2029");value.put("version",1);
        java.lang.reflect.Method utf8=ExpertConversationApplication.class.getDeclaredMethod("utf8",com.fasterxml.jackson.databind.JsonNode.class);utf8.setAccessible(true);
        byte[] bytes=(byte[])utf8.invoke(null,value);assertEquals(91,bytes.length);
        java.lang.reflect.Method digest=ExpertConversationApplication.class.getDeclaredMethod("digest",com.fasterxml.jackson.databind.JsonNode.class);digest.setAccessible(true);
        // Fixed JSON.stringify fixture covers Chinese, emoji, literal backslash-u, controls and U+2028/2029.
        assertEquals("sha256:75ec2ab8702f1ba5b55122ef53f4eccf0f1a5f52f2b2c616a8c9a98e818c3731",digest.invoke(null,value));
    }

    @Test void identityAndConversationCommandsRequireCurrentActorBeforeDatabase(){
        AtomicInteger calls=new AtomicInteger();ExpertConversationApplication app=new ExpertConversationApplication(ApplicationUnitTest.unavailable(calls),ApplicationUnitTest.policy(true),TransactionObserver.NONE);
        assertEquals(ErrorCode.UNAUTHENTICATED,assertThrows(ApplicationFault.class,()->app.identity(null)).code);
        assertEquals(ErrorCode.UNAUTHENTICATED,assertThrows(ApplicationFault.class,()->app.ensure(null,"command","group","bot","main",null,"Main","Hello")).code);
        assertEquals(0,calls.get());
    }
    @Test void malformedLifecycleRoleAndDuplicateTargetsNeverReachDatabase(){
        AtomicInteger calls=new AtomicInteger();ExpertConversationApplication app=new ExpertConversationApplication(ApplicationUnitTest.unavailable(calls),ApplicationUnitTest.policy(true),TransactionObserver.NONE);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.ensure(ApplicationUnitTest.ACTOR,"command","group","bot","personal",null,"Title","Goal")).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.freeze(ApplicationUnitTest.ACTOR,"command","task",1,1,"bot-version","request",Arrays.asList("same","same"))).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.lifecycle(ApplicationUnitTest.ACTOR,"command","task",1,"approve")).code);
        assertEquals(0,calls.get());
    }
}
