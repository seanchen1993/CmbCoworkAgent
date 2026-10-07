package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.adapters.local.*;
import com.devclaw.botcontrol.application.*;
import com.devclaw.botcontrol.contracts.BotContracts.*;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class HttpBoundaryTest {
    static byte[] bytes(String s) { return s.getBytes(StandardCharsets.UTF_8); }
    static ProtocolHeadValve.HeadField field(String head, String name, String value) { int at = head.indexOf(name + ":"); int start = at + name.length() + 1; return new ProtocolHeadValve.HeadField(name, value, at, start, start + value.length()); }
    static String config() {
        return "{\"mode\":\"local-dev\",\"http\":{\"host\":\"127.0.0.1\",\"port\":0},\"db\":{\"mode\":\"local-dev\",\"host\":\"127.0.0.1\",\"port\":32893,\"schema\":\"devclaw\",\"user\":\"devclaw_app\",\"password\":\"" + String.join("", Collections.nCopies(64, "a")) + "\"},\"identity\":{\"principals\":[{\"principalId\":\"p:1\",\"active\":true,\"spaces\":[{\"spaceId\":\"A\",\"member\":true,\"canCreateBot\":true,\"canCreateGroup\":false,\"knowledgeRefs\":[\"k.1\"],\"repositoryRefs\":[],\"skillAllowlist\":[],\"capabilityCeiling\":[\"repository.read\"]}]}],\"bearers\":[{\"principalId\":\"p:1\",\"token\":\"" + String.join("", Collections.nCopies(64, "b")) + "\"}]}}";
    }
    @Test void configIsClosedStrictAndReadsOnlyOneCompleteEOFDocument() {
        LocalLaunchConfig c = LocalLaunchConfig.read(new ByteArrayInputStream(bytes(config())));
        assertEquals("LocalLaunchConfig[local-dev]", c.toString());
        for (byte[] bad : Arrays.asList(bytes(config() + "{}"), bytes(config().replace("\"port\":0", "\"port\":\"0\"")),
            bytes(config().replace("\"port\":0", "\"port\":0,\"port\":0")), bytes(config().replace("\"http\":", "\"unknown\":{},\"http\":")),
            bytes(config().replace("127.0.0.1", "localhost")), bytes(config().replace("\"active\":true", "\"active\":1")),
            bytes(config().replace("\"k.1\"", "\"k.1\",\"k.1\"")), bytes(config().replace("\"member\":true", "\"member\":false")),
            new byte[]{(byte)0xc0, (byte)0xaf}, new byte[65537])) {
            IllegalArgumentException f = assertThrows(IllegalArgumentException.class, () -> LocalLaunchConfig.parse(bad));
            assertEquals("HTTP_CONFIG", f.getMessage()); assertNull(f.getCause());
        }
        assertThrows(IllegalArgumentException.class, () -> LocalLaunchConfig.read(new ByteArrayInputStream(bytes(config() + "{}"))));
    }
    @Test void immutableIdentityIsNotBearerSpaceOrTargetAuthority() {
        LocalIdentityRegistry r = LocalLaunchConfig.parse(bytes(config())).identity;
        String token = String.join("", Collections.nCopies(64, "b"));
        assertEquals("p:1", r.principalFor("Bearer " + token)); assertEquals("p:1", r.principalFor("bearer " + token));
        for (String bad : Arrays.asList("Bearer " + token + ",Bearer " + token, "Bearer  " + token, "Bearer " + token.toUpperCase(Locale.ROOT), "Bearer " + String.join("", Collections.nCopies(64, "c")))) assertNull(r.principalFor(bad));
        TrustedContext a = new TrustedContext("A", "p:1"), foreign = new TrustedContext("B", "p:1");
        assertTrue(r.activeMember("A", "p:1")); assertFalse(r.activeMember("B", "p:1")); assertFalse(r.activeMember("A", "other"));
        assertTrue(r.mayCreateBot(a)); assertFalse(r.mayCreateGroup(a)); assertFalse(r.mayCreateBot(foreign));
        assertTrue(r.mayAssociate(a, IdentityPolicy.Reference.KNOWLEDGE, "k.1")); assertFalse(r.mayAssociate(a, IdentityPolicy.Reference.KNOWLEDGE, "other"));
        assertTrue(r.mayConfigure(a, Capability.REPOSITORY_READ)); assertFalse(r.mayConfigure(a, Capability.WORKSPACE_WRITE));
        LocalIdentityRegistry inactive = LocalLaunchConfig.parse(bytes(config().replace("\"active\":true", "\"active\":false"))).identity;
        assertEquals("p:1", inactive.principalFor("Bearer " + token)); assertFalse(inactive.activeMember("A", "p:1"));
    }
    @Test void allSixRawRoutesDecodeOnlyIdOnceAndKeepSourcePunctuation() {
        for (Operation op : Operation.values()) {
            String path = op.path(op.create() ? null : "id:A.b-_1");
            RawRoute route = RawRoute.select(op.method, path, null); assertEquals(op, route.operation);
            assertEquals(op.create() ? null : "id:A.b-_1", route.id);
            if (!op.create()) assertEquals("id:A.b-_1", RawRoute.select(op.method, path.replace("id:A.b", "%69d%3AA%2Eb"), null).id);
        }
        for (String path : Arrays.asList("/api/%62ot/v1/bots/x", "/api/bot/v1/bots/x/", "/api/bot/v1/bots//x", "/api/bot/v1/bots/.", "/api/bot/v1/bots/%2e%2e",
            "/api/bot/v1/bots/x%2fy", "/api/bot/v1/bots/x%5cy", "/api/bot/v1/bots/x%3by", "/api/bot/v1/bots/x%253Ay", "/api/bot/v1/bots/%c0%af", "/api/bot/v1/bots/%", "/api/bot/v1/bots/x?")) assertThrows(HttpFailure.class, () -> RawRoute.select("GET", path, null));
        for (String method : Arrays.asList("HEAD", "OPTIONS", "DELETE", "TRACE", "get")) assertThrows(HttpFailure.class, () -> RawRoute.select(method, "/api/bot/v1/bots/x", null));
        assertThrows(HttpFailure.class, () -> RawRoute.select("GET", "/api/bot/v1/bots/x", ""));
        assertThrows(HttpFailure.class, () -> RawRoute.select("POST", "/api/bot/v1/bots/versions", null));
        assertThrows(HttpFailure.class, () -> RawRoute.select("PUT", "/api/bot/v1/groups/members", null));
        assertThrows(HttpFailure.class, () -> RawRoute.select("GET", "/api/bot/v1/bots/%３Ａ", null));
    }
    @Test void bodyHasActualByteBoundGETRejectionAndAbsoluteClockDeadline() {
        byte[] maximum = new byte[1048576]; assertArrayEquals(maximum, BoundedBody.read(new ByteArrayInputStream(maximum), Operation.CREATE_BOT));
        assertEquals(ErrorCode.PAYLOAD_TOO_LARGE, assertThrows(HttpFailure.class, () -> BoundedBody.read(new ByteArrayInputStream(new byte[1048577]), Operation.CREATE_BOT)).code);
        assertEquals(ErrorCode.INVALID_PAYLOAD, assertThrows(HttpFailure.class, () -> BoundedBody.read(new ByteArrayInputStream(new byte[1048577]), Operation.GET_BOT)).code);
        assertEquals(0, BoundedBody.read(new ByteArrayInputStream(new byte[0]), Operation.GET_BOT).length);
        AtomicLong clock = new AtomicLong(); InputStream drip = new ByteArrayInputStream(bytes("a")) { @Override public synchronized int read(byte[] b, int off, int len) { clock.set(5000000000L); return super.read(b, off, len); } };
        assertEquals(ErrorCode.INVALID_PAYLOAD, assertThrows(HttpFailure.class, () -> BoundedBody.read(drip, Operation.CREATE_BOT, clock::get)).code);
        InputStream broken = new InputStream() { public int read() throws IOException { throw new IOException("secret-input-sentinel"); } };
        HttpFailure f = assertThrows(HttpFailure.class, () -> BoundedBody.read(broken, Operation.CREATE_BOT)); assertNull(f.getCause()); assertEquals(0, f.getStackTrace().length);
    }
    @Test void transportErrorsAreSafeOriginalDeclaredResponses() {
        ContractBoundary b = new ContractBoundary();
        for (Operation op : Operation.values()) for (ErrorCode code : Arrays.asList(ErrorCode.INVALID_PAYLOAD, ErrorCode.UNAUTHENTICATED, ErrorCode.FORBIDDEN, ErrorCode.RATE_LIMITED, ErrorCode.DEPENDENCY_UNAVAILABLE)) {
            ApplicationResponse r = SafeHttpErrors.response(op, code); ErrorResponse e = b.readResponse(op.wire, r.status, r.body(), ErrorResponse.class);
            assertEquals(code, e.error.code); assertEquals("Request could not be completed", e.error.message);
        }
        for (Operation op : Operation.values()) if (op.write()) assertEquals(413, SafeHttpErrors.response(op, ErrorCode.PAYLOAD_TOO_LARGE).status);
        assertThrows(ContractBoundary.Failure.class, () -> SafeHttpErrors.response(Operation.GET_BOT, ErrorCode.PAYLOAD_TOO_LARGE));
        assertThrows(ContractBoundary.Failure.class, () -> SafeHttpErrors.response(Operation.CREATE_BOT, ErrorCode.NOT_FOUND));
        assertEquals(400, SafeHttpErrors.response(null, ErrorCode.INVALID_PAYLOAD).status);
        assertThrows(IllegalArgumentException.class, () -> SafeHttpErrors.response(Operation.CREATE_BOT, ErrorCode.OUTCOME_UNKNOWN));
    }
    @Test void pinnedHeaderViewNeverReadsBodyOrChangesBufferAndRejectsUncertainFolding() {
        String line = "POST /api/bot/v1/bots HTTP/1.1", head = line + "\r\nhost:127.0.0.1:1234\r\ncontent-length:0\r\n\r\n";
        ByteBuffer buffer = ByteBuffer.wrap(bytes(head + "content-length:9\r\ntransfer-encoding:chunked\r\n\r\n")); buffer.position(head.length());
        int limit = buffer.limit(); List<ProtocolHeadValve.HeadField> fields = Arrays.asList(field(head,"host","127.0.0.1:1234"), field(head,"content-length","0"));
        ProtocolHeadValve.check(buffer, line, fields); assertEquals(head.length(), buffer.position()); assertEquals(limit, buffer.limit());
        // CL was removed from MimeHeaders by prepareInputFilters, not from view.
        String ambiguous = line + "\r\ncontent-length:0\r\ntransfer-encoding:chunked\r\n\r\n";
        ByteBuffer both = ByteBuffer.wrap(bytes(ambiguous)); both.position(both.limit());
        assertThrows(HttpFailure.class, () -> ProtocolHeadValve.check(both, line, Collections.singletonList(field(ambiguous,"transfer-encoding","chunked"))));
        for (String malformed : Arrays.asList(line + "\r\nx:a b\n b\r\n\r\n", line + "\r\nx:wrong\r\n\r\n", line + "\r\n x:a\r\n\r\n", line + "\n\nx:a\n\n")) {
            ByteBuffer view = ByteBuffer.wrap(bytes(malformed)); view.position(view.limit());
            assertThrows(HttpFailure.class, () -> ProtocolHeadValve.check(view, line, Collections.singletonList(field(malformed,"x","a bcdef"))));
        }
        assertThrows(HttpFailure.class, () -> ProtocolHeadValve.check(buffer, "POST http://127.0.0.1:1234/api/bot/v1/bots HTTP/1.1", fields));
        ByteBuffer bodyPosition = buffer.duplicate(); bodyPosition.position(bodyPosition.limit());
        assertThrows(HttpFailure.class, () -> ProtocolHeadValve.check(bodyPosition, line, fields));
        String compacted = line + "\r\nhost:127.0.0.1:12344\r\ncontent-length:00\r\n\r\n";
        ByteBuffer ows = ByteBuffer.wrap(bytes(compacted)); ows.position(ows.limit());
        ProtocolHeadValve.check(ows, line, Arrays.asList(field(compacted,"host","127.0.0.1:1234"),field(compacted,"content-length","0")));
        // Fully overwritten folded value: exact parsed span is used, not stale
        // tail reconstruction or a false assertion that all wire folds are seen.
        String overwritten = line + "\r\nx:a bcdefef\r\n\r\n";
        ByteBuffer folded = ByteBuffer.wrap(bytes(overwritten)); folded.position(folded.limit());
        ProtocolHeadValve.check(folded,line,Collections.singletonList(field(overwritten,"x","a bcdef")));
    }
}
