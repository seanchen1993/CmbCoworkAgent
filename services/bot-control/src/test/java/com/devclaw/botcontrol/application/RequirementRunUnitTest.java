package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.*;
import java.lang.reflect.Proxy;
import java.sql.SQLException;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class RequirementRunUnitTest {
    final AtomicInteger connections = new AtomicInteger();
    final DataSource source = (DataSource)Proxy.newProxyInstance(getClass().getClassLoader(), new Class[]{DataSource.class}, (p,m,a) -> { connections.incrementAndGet(); throw new SQLException("SECRET_SQL"); });
    final TrustedContext owner = new TrustedContext("A","owner");
    final IdentityPolicy identity = new IdentityPolicy() {
        public boolean activeMember(String s,String p) { return "A".equals(s) && "owner".equals(p); }
        public boolean mayCreateBot(TrustedContext a) { throw new AssertionError(); } public boolean mayCreateGroup(TrustedContext a) { throw new AssertionError(); }
        public boolean mayAssociate(TrustedContext a,Reference r,String id) { throw new AssertionError(); }
        public boolean mayConfigure(TrustedContext a,Capability c) { throw new AssertionError("config is not execution"); }
    };
    final RuntimeAccessPolicy access = new RuntimeAccessPolicy() {
        public boolean mayUseCapability(TrustedContext a,Capability c) { return false; }
        public boolean mayUseWorkspace(TrustedContext a,String ref) { return false; }
    };
    final RequirementRunApplication app = new RequirementRunApplication(source,identity,access,TransactionObserver.NONE);
    void fault(ErrorCode code,Runnable run) { ApplicationFault f=assertThrows(ApplicationFault.class,run::run); assertEquals(code,f.code); assertNull(f.getCause()); assertEquals(code.wire(),f.getMessage()); }
    @Test void trustedPortsRequired() {
        assertThrows(IllegalArgumentException.class,()->new RequirementRunApplication(null,identity,access,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RequirementRunApplication(source,null,access,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RequirementRunApplication(source,identity,null,TransactionObserver.NONE));
        assertThrows(IllegalArgumentException.class,()->new RequirementRunApplication(source,identity,access,null));
    }
    @Test void malformedIdentityNeverReachesDatabase() {
        fault(ErrorCode.UNAUTHENTICATED,()->app.enqueueRequirement(null,"c","t","b",1,Instant.EPOCH));
        fault(ErrorCode.FORBIDDEN,()->app.enqueueRequirement(new TrustedContext("B","owner"),"c","t","b",1,Instant.EPOCH));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.enqueueRequirement(owner,"/secret","t","b",1,Instant.EPOCH));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.getRequirementRun(owner,"run\n")); assertEquals(0,connections.get());
    }
    @Test void deadlinesRequireMilliseconds() {
        for(Instant deadline:new Instant[]{null,Instant.parse("2026-10-11T00:00:00.000000001Z")}) fault(ErrorCode.INVALID_PAYLOAD,()->app.enqueueRequirement(owner,"c","t","b",1,deadline));
        assertEquals(0,connections.get());
    }
    @Test void taskAndRunVersionsStayWithinContractIntegers() {
        for(long v:new long[]{0,-1,9007199254740992L}) {
            fault(ErrorCode.INVALID_PAYLOAD,()->app.enqueueRequirement(owner,"c","t","b",v,Instant.EPOCH));
            fault(ErrorCode.INVALID_PAYLOAD,()->app.cancelPendingRequirementRun(owner,"run",v));
        } assertEquals(0,connections.get());
    }
    @Test void nodeIdentityIsNotAUserBodyField() {
        fault(ErrorCode.UNAUTHENTICATED,()->app.claimRequirementRun(null,"run"));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.claimRequirementRun(new TrustedNodeContext("A","/node","owner"),"run"));
        fault(ErrorCode.FORBIDDEN,()->app.claimRequirementRun(new TrustedNodeContext("A","node","intruder"),"run")); assertEquals(0,connections.get());
    }
    @Test void failedConnectionHasNoJdbcDetailsOrExecution() {
        fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->app.enqueueRequirement(owner,"c","t","b",1,Instant.EPOCH));
        fault(ErrorCode.DEPENDENCY_UNAVAILABLE,()->app.getRequirementRun(owner,"run"));
        assertEquals(2,connections.get()); assertEquals(30000,RequirementRunApplication.LEASE_MILLIS);
    }
    @Test void executionTicketsAndSafeFailureCodesAreValidatedBeforeSql() {
        TrustedNodeContext node=new TrustedNodeContext("A","node","owner");
        fault(ErrorCode.UNAUTHENTICATED,()->app.startRequirementRun(null,"run","attempt","lease",1));
        fault(ErrorCode.COMMAND_CONFLICT,()->app.startRequirementRun(node,"run","attempt","lease",2));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.renewRequirementRun(node,"run","attempt","/lease",1));
        for(String text:new String[]{null,""," ","SECRET_STACK","\uD800"})
            fault(ErrorCode.INVALID_PAYLOAD,()->app.settleRequirementRun(node,"run","attempt","lease",1,"failed",text));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.settleRequirementRun(node,"run","attempt","lease",1,"unknown","safe"));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.settleRequirementRun(node,"run","attempt","lease",1,"succeeded","\u0000"));
        fault(ErrorCode.INVALID_PAYLOAD,()->app.settleRequirementRun(node,"run","attempt","lease",1,"succeeded",String.join("",java.util.Collections.nCopies(16385,"x"))));
        assertEquals(0,connections.get());
    }
    @Test void explicitInternalDatesAreMillisIsoUtc() throws Exception {
        com.fasterxml.jackson.databind.ObjectMapper mapper=new com.fasterxml.jackson.databind.ObjectMapper();
        com.fasterxml.jackson.databind.module.SimpleModule module=new com.fasterxml.jackson.databind.module.SimpleModule();
        module.addSerializer(Instant.class,new RequirementInstantSerializer());mapper.registerModule(module);
        assertEquals("\"2026-10-11T00:00:00.001Z\"",mapper.writeValueAsString(Instant.parse("2026-10-11T00:00:00.001Z")));
        assertEquals("\"2026-10-11T00:00:00.000Z\"",mapper.writeValueAsString(Instant.parse("2026-10-11T00:00:00Z")));
    }
}
