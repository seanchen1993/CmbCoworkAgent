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
    final Operation operation; final String id, after; final Long limit;
    private RawRoute(Operation operation, String id) { this(operation, id, null, null); }
    private RawRoute(Operation operation, String id, String after, Long limit) { this.operation = operation; this.id = id; this.after = after; this.limit = limit; }
    static RawRoute select(String method, String uri, String query) {
        if (method == null || uri == null || uri.indexOf('?') >= 0 || uri.indexOf('#') >= 0) throw invalid();
        if (method.equals("GET") && uri.equals("/api/bot/v1/events")) return events(query);
        if (query != null) throw invalid();
        for (Operation op : Operation.values()) {
            if (op == Operation.GET_EVENTS) continue;
            if (!op.method.equals(method)) continue;
            if (op.create()) { if (op.path(null).equals(uri)) return new RawRoute(op, null); continue; }
            String prefix = op.bot() ? "/api/bot/v1/bots/" : op.task() ? "/api/bot/v1/tasks/" : "/api/bot/v1/groups/";
            String suffix = op == Operation.CREATE_BOT_VERSION ? "/versions" : op == Operation.UPDATE_GROUP_MEMBERS ? "/members" : op == Operation.CREATE_TASK_MESSAGE ? "/messages" : "";
            if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) continue;
            if (uri.length() < prefix.length() + suffix.length() + 1) throw invalid();
            String segment = uri.substring(prefix.length(), uri.length() - suffix.length());
            if (segment.isEmpty() || segment.indexOf('/') >= 0) continue;
            String id = decode(segment);
            try { BOUNDARY.validateParameter(op.wire, op.bot() ? "botId" : op.task() ? "taskId" : "groupId", id); }
            catch (ContractBoundary.Failure failure) {
                if (failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE) throw new HttpFailure(ErrorCode.DEPENDENCY_UNAVAILABLE);
                throw invalid();
            }
            return new RawRoute(op, id);
        }
        throw invalid();
    }
    private static String decode(String text) {
        String id = decodeValue(text, 384);
        if (id.equals(".") || id.equals("..") || id.indexOf('%') >= 0 || id.indexOf('/') >= 0 || id.indexOf('\\') >= 0 || id.indexOf(';') >= 0) throw invalid();
        return id;
    }
    private static RawRoute events(String query) {
        String after = null; Long limit = null;
        if (query != null) {
            if (query.isEmpty() || query.length() > 1570) throw invalid();
            String[] parameters = query.split("&", -1); if (parameters.length > 2) throw invalid();
            for (String parameter : parameters) {
                int equal = parameter.indexOf('='); if (equal < 1 || equal != parameter.lastIndexOf('=')) throw invalid();
                String name = parameter.substring(0, equal), value = decodeValue(parameter.substring(equal + 1), 1536);
                try {
                    if (name.equals("after") && after == null) after = BOUNDARY.validateParameter("getEvents", name, value);
                    else if (name.equals("limit") && limit == null && value.matches("[1-9][0-9]{0,2}")) limit = BOUNDARY.validateIntegerParameter("getEvents", name, Long.parseLong(value));
                    else throw invalid();
                } catch (ContractBoundary.Failure failure) { throw new HttpFailure(failure.category() == ContractBoundary.Category.SCHEMA_RESOURCE ? ErrorCode.DEPENDENCY_UNAVAILABLE : ErrorCode.INVALID_PAYLOAD); }
            }
        }
        return new RawRoute(Operation.GET_EVENTS, null, after, limit);
    }
    private static String decodeValue(String text, int maximum) {
        try {
            // A 128-character ASCII Id can require at most 384 raw bytes.
            if (text.length() > maximum) throw invalid();
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
            return id;
        } catch (HttpFailure failure) { throw failure; }
        catch (Exception failure) { throw invalid(); }
    }
    private static int hex(char c) { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; return -1; }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
