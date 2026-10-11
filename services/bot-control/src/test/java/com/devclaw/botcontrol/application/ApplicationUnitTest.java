package com.devclaw.botcontrol.application;

import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.domain.*;
import com.devclaw.botcontrol.persistence.JdbcApplicationStore;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ApplicationUnitTest {
    private final ContractBoundary boundary = new ContractBoundary();
    static final TrustedContext ACTOR = new TrustedContext("space.A", "principal:A");
    static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    static BotConfig config() {
        BotConfig c = new BotConfig(); c.description = "description"; c.instructions = "instructions";
        c.knowledgeRefs = Arrays.asList("k1", "k2"); c.repositoryRefs = Collections.emptyList(); c.skillAllowlist = Collections.emptyList();
        c.capabilityCeiling = Arrays.asList(Capability.REPOSITORY_READ); c.memoryPolicy = BotConfigMemoryPolicy.DISABLED; return c;
    }
    static CreateBotRequest create() { CreateBotRequest r = new CreateBotRequest(); r.commandId = "command"; r.name = "name"; r.config = config(); r.maintainerIds = Arrays.asList("principal:A", "p2"); return r; }
    static IdentityPolicy policy(boolean active) {
        return new IdentityPolicy() {
            public boolean activeMember(String s, String p) { return active; }
            public boolean mayCreateBot(TrustedContext a) { return active; }
            public boolean mayCreateGroup(TrustedContext a) { return active; }
            public boolean mayAssociate(TrustedContext a, Reference r, String id) { return active; }
            public boolean mayConfigure(TrustedContext a, Capability c) { return active; }
        };
    }
    static DataSource unavailable(AtomicInteger calls) {
        return (DataSource)Proxy.newProxyInstance(DataSource.class.getClassLoader(), new Class<?>[]{DataSource.class}, (proxy, method, args) -> {
            if (method.getName().equals("getConnection")) { calls.incrementAndGet(); throw new java.sql.SQLException("SQL-password-input-sentinel"); }
            throw new UnsupportedOperationException();
        });
    }
    @Test void canonicalTypedIntegersObjectsAndScopedPaths() {
        String template = "{\"commandId\":\"c\",\"expectedVersion\":%s,\"config\":" + new String(JdbcApplicationStore.json(config()), StandardCharsets.UTF_8) + "}";
        byte[] expected = null;
        for (String integer : Arrays.asList("1", "1.0", "1e0")) {
            CreateBotVersionRequest r = boundary.readRequest("createBotVersion", bytes(String.format(template, integer)), CreateBotVersionRequest.class);
            byte[] actual = CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT_VERSION, "bot", r);
            if (expected == null) expected = actual; else assertArrayEquals(expected, actual);
            r.commandId = "other"; assertArrayEquals(expected, CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT_VERSION, "bot", r));
            assertFalse(Arrays.equals(expected, CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT_VERSION, "Bot", r)));
            r.expectedVersion = 2L; assertFalse(Arrays.equals(expected, CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT_VERSION, "bot", r)));
        }
        CreateBotRequest r = create(); byte[] original = CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT, null, r);
        Collections.reverse(r.config.knowledgeRefs); assertFalse(Arrays.equals(original, CanonicalCommand.fingerprint(ACTOR, Operation.CREATE_BOT, null, r)));
        assertFalse(Arrays.equals(original, CanonicalCommand.fingerprint(new TrustedContext("other", ACTOR.principalId), Operation.CREATE_BOT, null, create())));
    }
    @Test void responsesAreImmutableAndFaultsContainNoCauses() {
        byte[] b = bytes("body"); ApplicationResponse r = new ApplicationResponse(200, b); b[0] = 0; byte[] copy = r.body(); copy[1] = 0;
        assertArrayEquals(bytes("body"), r.body()); ApplicationFault f = new ApplicationFault(ErrorCode.FORBIDDEN);
        assertNull(f.getCause()); assertEquals(0, f.getStackTrace().length); assertEquals("FORBIDDEN", f.getMessage());
    }
    @Test void allSelectorsUseDeclaredSafeErrorsWithoutDatabaseForBadInput() throws Exception {
        AtomicInteger calls = new AtomicInteger(); BotApplication app = new BotApplication(unavailable(calls), policy(true));
        for (Operation op : Operation.values()) {
            if (op.task()) continue; // Task core has its own equally strict selector tests.
            String id = op.create() ? null : "object";
            ApplicationResponse noActor = app.execute(op, null, id, op.write() ? bytes("{}") : null);
            assertEquals(401, noActor.status); boundary.readResponse(op.wire, noActor.status, noActor.body(), ErrorResponse.class);
            ApplicationResponse bad = app.execute(op, ACTOR, id, bytes("{}")); assertEquals(400, bad.status); boundary.readResponse(op.wire, bad.status, bad.body(), ErrorResponse.class);
            ApplicationResponse large = app.execute(op, ACTOR, id, new byte[1048577]); assertEquals(op.write() ? 413 : 400, large.status);
            boundary.readResponse(op.wire, large.status, large.body(), ErrorResponse.class);
        }
        assertEquals(0, calls.get());
        ApplicationResponse unavailable = app.execute(Operation.CREATE_BOT, ACTOR, null, JdbcApplicationStore.json(create()));
        assertEquals(503, unavailable.status); assertEquals(1, calls.get()); assertFalse(new String(unavailable.body(), StandardCharsets.UTF_8).contains("sentinel"));
        assertEquals(403, new BotApplication(unavailable(calls), policy(false)).execute(Operation.CREATE_BOT, ACTOR, null, JdbcApplicationStore.json(create())).status);
        assertEquals(1, calls.get());
    }
    @Test void originalStoredConfigAndLimitsCannotCoerceOrHideCorruption() {
        byte[] good = JdbcApplicationStore.json(config()); assertEquals("description", JdbcApplicationStore.storedConfig(good).description);
        String text = new String(good, StandardCharsets.UTF_8);
        for (byte[] bad : Arrays.asList(bytes(text + "{}"), bytes(text.replace("\"description\":\"description\"", "\"description\":true")),
            bytes(text.replace("\"description\":\"description\"", "\"description\":\"one\",\"description\":\"two\"")),
            bytes(text.replace("\"memoryPolicy\":\"disabled\"", "\"memoryPolicy\":\"unknown\"")), new byte[]{'{', '"', (byte)0xc0, (byte)0xaf, '"', ':', '1', '}'})) {
            ApplicationFault f = assertThrows(ApplicationFault.class, () -> JdbcApplicationStore.storedConfig(bad)); assertEquals(ErrorCode.DEPENDENCY_UNAVAILABLE, f.code);
        }
        assertEquals(1L, JdbcApplicationStore.storedLimits(bytes("{\"maxHandoffs\":1.0,\"maxRuns\":1e0,\"maxTokens\":1}")).maxTokens);
        for (String bad : Arrays.asList("{\"maxHandoffs\":\"1\",\"maxRuns\":1,\"maxTokens\":1}", "{\"maxHandoffs\":1,\"maxRuns\":1,\"maxTokens\":1,\"maxTokens\":2}", "{\"maxHandoffs\":1,\"maxRuns\":1,\"maxTokens\":1.0000000000000001}")) assertThrows(ApplicationFault.class, () -> JdbcApplicationStore.storedLimits(bytes(bad)));
    }
    @Test void maximumCodePointTextAndEscapedUTF16RemainSourceLegal() {
        CreateBotRequest r = create(); String emoji = String.join("", Collections.nCopies(16384, "🚀"));
        r.config.description = emoji; r.config.instructions = emoji; r.config.persona = emoji;
        r.name = "x\u0000\ud800\udc00"; byte[] original = JdbcApplicationStore.json(r);
        CreateBotRequest parsed = boundary.readRequest("createBot", original, CreateBotRequest.class);
        assertEquals(emoji, parsed.config.description); assertEquals(r.name, parsed.name);
        assertEquals(emoji, JdbcApplicationStore.storedConfig(JdbcApplicationStore.json(parsed.config)).persona);
        r.config.description += "🚀"; assertThrows(ContractBoundary.Failure.class, () -> boundary.readRequest("createBot", JdbcApplicationStore.json(r), CreateBotRequest.class));
    }
}
