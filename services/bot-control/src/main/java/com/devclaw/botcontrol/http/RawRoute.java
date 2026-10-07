package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.Operation;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.validation.ContractBoundary;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.*;

/** Raw fixed literals, and exactly one strict decoding of the Id segment. */
final class RawRoute {
    private static final ContractBoundary BOUNDARY = new ContractBoundary();
    final Operation operation; final String id;
    private RawRoute(Operation operation, String id) { this.operation = operation; this.id = id; }
    static RawRoute select(String method, String uri, String query) {
        if (method == null || uri == null || query != null || uri.indexOf('?') >= 0 || uri.indexOf('#') >= 0) throw invalid();
        for (Operation op : Operation.values()) {
            if (!op.method.equals(method)) continue;
            if (op.create()) { if (op.path(null).equals(uri)) return new RawRoute(op, null); continue; }
            String prefix = op.bot() ? "/api/bot/v1/bots/" : "/api/bot/v1/groups/";
            String suffix = op == Operation.CREATE_BOT_VERSION ? "/versions" : op == Operation.UPDATE_GROUP_MEMBERS ? "/members" : "";
            if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) continue;
            if (uri.length() < prefix.length() + suffix.length() + 1) throw invalid();
            String segment = uri.substring(prefix.length(), uri.length() - suffix.length());
            if (segment.isEmpty() || segment.indexOf('/') >= 0) continue;
            String id = decode(segment);
            try { BOUNDARY.validateParameter(op.wire, op.bot() ? "botId" : "groupId", id); }
            catch (ContractBoundary.Failure failure) {
                if (failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE) throw new HttpFailure(ErrorCode.DEPENDENCY_UNAVAILABLE);
                throw invalid();
            }
            return new RawRoute(op, id);
        }
        throw invalid();
    }
    private static String decode(String text) {
        try {
            // A 128-character ASCII Id can require at most 384 raw bytes.
            if (text.length() > 384) throw invalid();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            for (int i = 0; i < text.length(); i++) {
                char c = text.charAt(i);
                if (c == '%') {
                    if (i + 2 >= text.length()) throw invalid();
                    int hi = hex(text.charAt(++i)), lo = hex(text.charAt(++i));
                    if (hi < 0 || lo < 0) throw invalid();
                    out.write(hi * 16 + lo);
                } else { if (c > 127) throw invalid(); out.write(c); }
            }
            String id = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(out.toByteArray())).toString();
            if (id.equals(".") || id.equals("..") || id.indexOf('%') >= 0 || id.indexOf('/') >= 0 || id.indexOf('\\') >= 0 || id.indexOf(';') >= 0) throw invalid();
            return id;
        } catch (HttpFailure failure) { throw failure; }
        catch (Exception failure) { throw invalid(); }
    }
    private static int hex(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; return -1; }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
