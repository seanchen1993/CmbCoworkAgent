package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.persistence.JdbcRuntimeNodeStore;
import com.devclaw.botcontrol.ports.*;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RuntimeNodeUnitTest {
    final AtomicInteger connections = new AtomicInteger();
    final DataSource source = (DataSource)Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{DataSource.class}, (p,m,a) -> { connections.incrementAndGet(); throw new SQLException("DO_NOT_EXPOSE"); });
    final TrustedContext actor = new TrustedContext("A","owner");
    final IdentityPolicy identity = new IdentityPolicy() {
        public boolean activeMember(String s,String p) { return "A".equals(s) && "owner".equals(p); }
        public boolean mayCreateBot(TrustedContext a) { throw new AssertionError(); } public boolean mayCreateGroup(TrustedContext a) { throw new AssertionError(); }
        public boolean mayAssociate(TrustedContext a,Reference r,String id) { throw new AssertionError(); }
        public boolean mayConfigure(TrustedContext a,Capability c) { throw new AssertionError("configuration is not execution"); }
    };
    final RuntimeAccessPolicy access = new RuntimeAccessPolicy() {
        public boolean mayUseCapability(TrustedContext a,Capability c) { return false; }
        public boolean mayUseWorkspace(TrustedContext a,String ref) { return false; }
    };
    final RuntimeNodeApplication app = new RuntimeNodeApplication(source,identity,access,TransactionObserver.NONE);
    void fault(ErrorCode code,Runnable run) { ApplicationFault f=assertThrows(ApplicationFault.class,run::run); assertEquals(code,f.code); assertNull(f.getCause()); assertEquals(code.wire(),f.getMessage()); }
    @Test void constructionRequiresAllTrustedPorts() {
        assertThrows(IllegalArgumentException.class,()->new RuntimeNodeApplication(source,identity,null,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RuntimeNodeApplication(source,null,access,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RuntimeNodeApplication(null,identity,access,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RuntimeNodeApplication(source,identity,access,null));
    }
    @Test void identityAndNodeInputsCannotReachDatabase() {
        fault(ErrorCode.UNAUTHENTICATED,()->app.observeDesktopNode(null,true,Collections.emptySet()));
        fault(ErrorCode.FORBIDDEN,()->app.observeDesktopNode(new TrustedNodeContext("B","node","owner"),true,Collections.emptySet()));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.observeDesktopNode(new TrustedNodeContext("A","/path","owner"),true,Collections.emptySet()));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.observeDesktopNode(new TrustedNodeContext("A","node","owner"),true,null));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.observeDesktopNode(new TrustedNodeContext("A","node","owner"),true,Collections.singleton(null)));
        assertEquals(0,connections.get());
    }
    @Test void grantBoundsAndMillisecondPrecisionAreExplicit() {
        for(long v:new long[]{-1,9007199254740992L}) fault(ErrorCode.INVALID_PAYLOAD,()->app.authorizeRequirementNode(actor,"group","node","view",v,Instant.now()));
        for(Instant t:new Instant[]{null,Instant.parse("2026-10-11T00:00:00.000000001Z")}) fault(ErrorCode.INVALID_PAYLOAD,()->app.authorizeRequirementNode(actor,"group","node","view",0,t));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.authorizeRequirementNode(actor,"group","node","/host/path",0,Instant.EPOCH));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.revokeRequirementNode(actor,"group",-1)); assertEquals(0,connections.get());
    }
    @Test void dispatchRequiresTrustedActorAndExplicitIds() {
        fault(ErrorCode.UNAUTHENTICATED,()->app.resolveRequirementDispatch(null,"task","bot"));
        fault(ErrorCode.FORBIDDEN,()->app.resolveRequirementDispatch(new TrustedContext("A","other"),"task","bot"));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.resolveRequirementDispatch(actor,null,"bot"));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.resolveRequirementDispatch(actor,"task","bot\n")); assertEquals(0,connections.get());
    }
    @Test void capabilitiesValidateOriginalBytesAndAreImmutable() {
        for(String bytes:Arrays.asList("null","{}","[1]","[null]","[true]","[\"unknown\"]","[\"requirements.analyze\",\"requirements.analyze\"]","[] []"))
            fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->JdbcRuntimeNodeStore.storedCapabilities(bytes.getBytes(StandardCharsets.UTF_8)));
        fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->JdbcRuntimeNodeStore.storedCapabilities(null));
        fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->JdbcRuntimeNodeStore.storedCapabilities(new byte[513]));
        Set<Capability> caps=JdbcRuntimeNodeStore.storedCapabilities("[\"requirements.analyze\"]".getBytes(StandardCharsets.UTF_8));
        assertEquals(Collections.singleton(Capability.REQUIREMENTS_ANALYZE),caps); assertThrows(UnsupportedOperationException.class,()->caps.clear());
    }
    @Test void dependencyFailuresNeverExposeJdbcOrGrantRights() {
        fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->app.resolveRequirementDispatch(actor,"task","bot"));
        assertEquals(1,connections.get()); assertEquals(60000,RuntimeNodeApplication.HEARTBEAT_TTL_MILLIS);
    }
}
