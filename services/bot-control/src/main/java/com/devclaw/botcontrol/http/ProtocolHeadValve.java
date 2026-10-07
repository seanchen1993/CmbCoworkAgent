package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;
import javax.servlet.ServletException;
import org.apache.catalina.connector.Request;
import org.apache.catalina.connector.Response;
import org.apache.catalina.valves.ValveBase;
import org.apache.coyote.http11.Http11InputBuffer;
import org.apache.tomcat.util.http.MimeHeaders;

/** Pinned 9.0.83 read-only current header view, NOT an unmodified wire copy. */
final class ProtocolHeadValve extends ValveBase {
    ProtocolHeadValve() { super(true); }
    @Override public void invoke(Request request, Response response) throws IOException, ServletException {
        try {
            org.apache.coyote.Request coyote = request.getCoyoteRequest();
            if (!(coyote.getInputBuffer() instanceof Http11InputBuffer) || coyote.getBytesRead() != 0) throw invalid();
            ByteBuffer original = ((Http11InputBuffer)coyote.getInputBuffer()).getByteBuffer();
            int position = original.position(), limit = original.limit();
            String target = coyote.requestURI().toString();
            if (!coyote.queryString().isNull()) target += "?" + coyote.queryString().toString();
            MimeHeaders headers = coyote.getMimeHeaders(); List<String[]> observed = new ArrayList<String[]>();
            for (int i = 0; i < headers.size(); i++) observed.add(new String[]{headers.getName(i).toString(), headers.getValue(i).toString()});
            check(original.asReadOnlyBuffer(), coyote.method().toString() + " " + target + " " + coyote.protocol().toString(), observed);
            if (original.position() != position || original.limit() != limit) throw invalid();
            getNext().invoke(request, response);
        } catch (HttpFailure failure) {
            response.setHeader("Connection", "close");
            HttpOutput.write(response, SafeHttpErrors.response(null, ErrorCode.INVALID_PAYLOAD));
        }
    }
    static void check(ByteBuffer view, String expectedLine, List<String[]> normalized) {
        int end = view.position();
        if (end < 4 || end > 8192 || view.limit() < end) throw invalid();
        ByteBuffer header = view.asReadOnlyBuffer(); header.limit(end); header.position(0);
        byte[] bytes = new byte[end]; header.get(bytes);
        String text = new String(bytes, StandardCharsets.ISO_8859_1);
        if (!text.endsWith("\r\n\r\n")) throw invalid();
        String[] lines = text.substring(0, text.length() - 4).split("\r\n", -1);
        if (lines.length < 1 || !lines[0].equals(expectedLine) || !lines[0].endsWith(" HTTP/1.1") || lines.length - 1 > 32) throw invalid();
        List<String[]> physical = new ArrayList<String[]>(); boolean length = false, encoding = false;
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i]; int colon = line.indexOf(':');
            if (colon < 1 || !line.substring(0, colon).matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw invalid();
            String name = line.substring(0, colon).toLowerCase(Locale.ROOT), value = line.substring(colon + 1);
            for (int k = 0; k < value.length(); k++) if ((value.charAt(k) < 32 && value.charAt(k) != '\t') || value.charAt(k) == 127) throw invalid();
            value = trimOWS(value); length |= name.equals("content-length"); encoding |= name.equals("transfer-encoding");
            physical.add(new String[]{name, value});
        }
        // prepareInputFilters removes CL from MimeHeaders in the ambiguous case,
        // but the bounded header window still retains its field name.
        if (length && encoding) throw invalid();
        if (physical.size() != normalized.size()) throw invalid();
        for (int i = 0; i < physical.size(); i++) {
            String[] a = physical.get(i), b = normalized.get(i);
            if (!a[0].equalsIgnoreCase(b[0]) || !a[1].equals(b[1])) throw invalid();
        }
        // Value compaction/folding may overwrite old CRLFs. Any view whose line
        // structure/values disagree with parsed headers is rejected, not guessed.
    }
    private static String trimOWS(String value) { int first = 0, last = value.length(); while (first < last && (value.charAt(first) == ' ' || value.charAt(first) == '\t')) first++; while (last > first && (value.charAt(last - 1) == ' ' || value.charAt(last - 1) == '\t')) last--; return value.substring(first, last); }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
