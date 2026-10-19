package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.TransactionObserver;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ExpertConversationUnitTest {
    @Test void identityAndConversationCommandsRequireCurrentActorBeforeDatabase(){
        AtomicInteger calls=new AtomicInteger();ExpertConversationApplication app=new ExpertConversationApplication(ApplicationUnitTest.unavailable(calls),ApplicationUnitTest.policy(true),TransactionObserver.NONE);
        assertEquals(ErrorCode.UNAUTHENTICATED,assertThrows(ApplicationFault.class,()->app.identity(null)).code);
        assertEquals(ErrorCode.UNAUTHENTICATED,assertThrows(ApplicationFault.class,()->app.ensure(null,"command","group","bot","main",null,"Main","Hello")).code);
        assertEquals(0,calls.get());
    }
    @Test void malformedLifecycleRoleAndDuplicateTargetsNeverReachDatabase(){
        AtomicInteger calls=new AtomicInteger();ExpertConversationApplication app=new ExpertConversationApplication(ApplicationUnitTest.unavailable(calls),ApplicationUnitTest.policy(true),TransactionObserver.NONE);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.ensure(ApplicationUnitTest.ACTOR,"command","group","bot","personal",null,"Title","Goal")).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.freeze(ApplicationUnitTest.ACTOR,"command","task",1,"request",Arrays.asList("same","same"))).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD,assertThrows(ApplicationFault.class,()->app.lifecycle(ApplicationUnitTest.ACTOR,"command","task",1,"approve")).code);
        assertEquals(0,calls.get());
    }
}
