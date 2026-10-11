package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.*;
import java.lang.reflect.Proxy;
import java.sql.SQLException;
import java.time.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class NodeCredentialUnitTest {
    static final Instant NOW = Instant.parse("2026-10-11T00:00:00Z");
    static final String TOKEN = "dcn1_" + String.join("", Collections.nCopies(64, "a"));
    static final String SECOND = "dcn1_" + String.join("", Collections.nCopies(64, "b"));
    static final class TestClock extends Clock {
        Instant now = NOW;
        public ZoneId getZone() { return ZoneOffset.UTC; }
        public Clock withZone(ZoneId zone) { return this; }
        public Instant instant() { return now; }
    }
    final TestClock clock = new TestClock();
    LocalNodeCredentialRegistry.Binding binding(String space, String node, String owner, String token) {
        return new LocalNodeCredentialRegistry.Binding(space, node, owner, token, NOW.plusSeconds(60));
    }
    LocalNodeCredentialRegistry registry() { return new LocalNodeCredentialRegistry(clock, Collections.singletonList(binding("A","node","owner",TOKEN))); }
    void unauthenticated(Runnable action) {
        ApplicationFault fault = assertThrows(ApplicationFault.class, action::run);
        assertEquals(ErrorCode.UNAUTHENTICATED, fault.code); assertNull(fault.getCause()); assertEquals("UNAUTHENTICATED", fault.getMessage());
    }
    @Test void nodeCredentialIsPurposeBoundAndExact() {
        LocalNodeCredentialRegistry r = registry();
        for (String header : new String[]{null, "Bearer "+TOKEN.substring(5), "Bearer "+SECOND, "Basic "+TOKEN, "Bearer "+TOKEN+"\n", "Bearer  "+TOKEN, "Bearer "+TOKEN+", x", "Bearer "+TOKEN.toUpperCase()}) unauthenticated(()->r.authenticate(header));
        TrustedNodeContext c = r.use(r.authenticate("bEaReR "+TOKEN), context->context);
        assertEquals("A",c.spaceId); assertEquals("node",c.nodeId); assertEquals("owner",c.ownerPrincipalId);
        assertFalse(r.toString().contains(TOKEN)); assertFalse(r.authenticate("Bearer "+TOKEN).toString().contains(TOKEN));
    }
    @Test void expiredAndRevokedSessionsCannotAct() {
        LocalNodeCredentialRegistry r=registry(); LocalNodeCredentialRegistry.Session session=r.authenticate("Bearer "+TOKEN);
        clock.now=NOW.plusSeconds(60); unauthenticated(()->r.authenticate("Bearer "+TOKEN)); unauthenticated(()->r.use(session,c->{throw new AssertionError();}));
        clock.now=NOW; r.revoke("A","node"); unauthenticated(()->r.use(session,c->{throw new AssertionError();})); unauthenticated(()->r.authenticate("Bearer "+TOKEN));
    }
    @Test void rotationInvalidatesOldSessionWithoutChangingTrustedIdentity() {
        LocalNodeCredentialRegistry r=registry(); LocalNodeCredentialRegistry.Session old=r.authenticate("Bearer "+TOKEN);
        r.replace(Collections.singletonList(binding("A","node","owner",SECOND)));
        unauthenticated(()->r.use(old,c->{throw new AssertionError();})); unauthenticated(()->r.authenticate("Bearer "+TOKEN));
        assertEquals("owner",r.use(r.authenticate("Bearer "+SECOND),c->c.ownerPrincipalId));
        r.replace(Collections.singletonList(binding("A","node","owner",SECOND))); unauthenticated(()->r.use(old,c->c));
    }
    @Test void invalidReloadIsAtomicAndHasNoSecrets() {
        LocalNodeCredentialRegistry r=registry(); LocalNodeCredentialRegistry.Session old=r.authenticate("Bearer "+TOKEN);
        List<List<LocalNodeCredentialRegistry.Binding>> bad=Arrays.asList(null,
            Arrays.asList(binding("A","node","owner",TOKEN),binding("A","node","owner",SECOND)),
            Arrays.asList(binding("A","node","owner",TOKEN),binding("B","node","owner",TOKEN)),
            Collections.singletonList(binding("/SECRET","node","owner",TOKEN)),
            Collections.singletonList(binding("A","node","owner","SECRET")),
            Collections.singletonList(new LocalNodeCredentialRegistry.Binding("A","node","owner",TOKEN,NOW)),
            Collections.singletonList(new LocalNodeCredentialRegistry.Binding("A","node","owner",TOKEN,NOW.plusNanos(1))),
            Collections.nCopies(17,binding("A","node","owner",TOKEN)));
        for(List<LocalNodeCredentialRegistry.Binding> values:bad) {
            IllegalArgumentException f=assertThrows(IllegalArgumentException.class,()->r.replace(values));
            assertEquals("NODE_CREDENTIAL_CONFIG_INVALID",f.getMessage()); assertNull(f.getCause()); assertEquals("node",r.use(old,c->c.nodeId));
        }
    }
    @Test void sessionCannotMoveBetweenRegistriesOrSpaces() {
        LocalNodeCredentialRegistry r=registry(),other=registry(); LocalNodeCredentialRegistry.Session session=r.authenticate("Bearer "+TOKEN);
        unauthenticated(()->other.use(session,c->{throw new AssertionError();}));
        r.replace(Arrays.asList(binding("A","node","owner",TOKEN),binding("B","node","other-owner",SECOND)));
        assertEquals("B",r.use(r.authenticate("Bearer "+SECOND),c->c.spaceId));
        assertEquals("other-owner",r.use(r.authenticate("Bearer "+SECOND),c->c.ownerPrincipalId));
    }
    @Test void adapterRejectsStaleSessionBeforeDatabaseAndStillChecksMembership() {
        AtomicInteger connections=new AtomicInteger();
        DataSource source=(DataSource)Proxy.newProxyInstance(getClass().getClassLoader(),new Class[]{DataSource.class},(p,m,a)->{connections.incrementAndGet();throw new SQLException("SECRET_SQL");});
        IdentityPolicy identity=new IdentityPolicy(){public boolean activeMember(String s,String p){return false;}
            public boolean mayCreateBot(TrustedContext a){throw new AssertionError();} public boolean mayCreateGroup(TrustedContext a){throw new AssertionError();}
            public boolean mayAssociate(TrustedContext a,Reference r,String id){throw new AssertionError();} public boolean mayConfigure(TrustedContext a,Capability c){throw new AssertionError();}};
        RuntimeAccessPolicy access=new RuntimeAccessPolicy(){public boolean mayUseCapability(TrustedContext a,Capability c){throw new AssertionError();}public boolean mayUseWorkspace(TrustedContext a,String ref){throw new AssertionError();}};
        LocalNodeCredentialRegistry r=registry(); LocalAuthenticatedNodeAdapter adapter=new LocalAuthenticatedNodeAdapter(r,new RuntimeNodeApplication(source,identity,access,TransactionObserver.NONE),new RequirementRunApplication(source,identity,access,TransactionObserver.NONE));
        LocalNodeCredentialRegistry.Session session=adapter.authenticate("Bearer "+TOKEN);
        assertEquals(ErrorCode.FORBIDDEN,assertThrows(ApplicationFault.class,()->adapter.claim(session,"run")).code);
        r.revoke("A","node"); unauthenticated(()->adapter.claim(session,"run")); unauthenticated(()->adapter.observe(session,true,Collections.singleton(Capability.REQUIREMENTS_ANALYZE))); assertEquals(0,connections.get());
    }
}
