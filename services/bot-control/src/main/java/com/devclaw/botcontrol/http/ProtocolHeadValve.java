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
import org.apache.tomcat.util.buf.MessageBytes;

/** Pinned 9.0.83 read-only current header view, NOT an unmodified wire copy. */
final class ProtocolHeadValve extends ValveBase {
    static final class HeadField {
        final String name, value; final int nameStart, valueStart, valueEnd;
        HeadField(String name, String value, int nameStart, int valueStart, int valueEnd) { this.name = name; this.value = value; this.nameStart = nameStart; this.valueStart = valueStart; this.valueEnd = valueEnd; }
    }
    ProtocolHeadValve() { super(true); }
    @Override public void invoke(Request request, Response response) throws IOException, ServletException {
        try {
            org.apache.coyote.Request coyote = request.getCoyoteRequest();
            if (!(coyote.getInputBuffer() instanceof Http11InputBuffer) || coyote.getBytesRead() != 0) throw invalid();
            ByteBuffer original = ((Http11InputBuffer)coyote.getInputBuffer()).getByteBuffer();
            int position = original.position(), limit = original.limit();
            String target = coyote.requestURI().toString();
            if (!coyote.queryString().isNull()) target += "?" + coyote.queryString().toString();
            MimeHeaders headers = coyote.getMimeHeaders(); List<HeadField> observed = new ArrayList<HeadField>();
            for (int i = 0; i < headers.size(); i++) {
                MessageBytes name = headers.getName(i), value = headers.getValue(i);
                if (name.getType() != MessageBytes.T_BYTES || value.getType() != MessageBytes.T_BYTES || !original.hasArray() ||
                    name.getByteChunk().getBuffer() != original.array() || value.getByteChunk().getBuffer() != original.array()) throw invalid();
                observed.add(new HeadField(name.toString(), value.toString(), name.getByteChunk().getStart(), value.getByteChunk().getStart(), value.getByteChunk().getEnd()));
            }
            check(original.asReadOnlyBuffer(), coyote.method().toString() + " " + target + " " + coyote.protocol().toString(), observed);
            if (original.position() != position || original.limit() != limit) throw invalid();
            getNext().invoke(request, response);
        } catch (HttpFailure failure) {
            response.setHeader("Connection", "close");
            HttpOutput.write(response, SafeHttpErrors.response(null, ErrorCode.INVALID_PAYLOAD));
        }
    }
    static void check(ByteBuffer view, String expectedLine, List<HeadField> normalized) {
        int end = view.position();
        if (end < 4 || end > 8192 || view.limit() < end) throw invalid();
        ByteBuffer header = view.asReadOnlyBuffer(); header.limit(end); header.position(0);
        byte[] bytes = new byte[end]; header.get(bytes);
        String text = new String(bytes, StandardCharsets.ISO_8859_1);
        if (!text.endsWith("\r\n\r\n")) throw invalid();
        String[] lines = text.substring(0, text.length() - 4).split("\r\n", -1);
        if (lines.length < 1 || !lines[0].equals(expectedLine) || !lines[0].endsWith(" HTTP/1.1") || lines.length - 1 > 32) throw invalid();
        List<HeadField> physical = new ArrayList<HeadField>(); boolean length = false, encoding = false;
        int offset = lines[0].length() + 2;
        for (int i = 1; i < lines.length; i++) {
            String line = lines[i]; int colon = line.indexOf(':');
            if (colon < 1 || !line.substring(0, colon).matches("[!#$%&'*+.^_`|~0-9A-Za-z-]+")) throw invalid();
            String name = line.substring(0, colon).toLowerCase(Locale.ROOT), value = line.substring(colon + 1);
            for (int k = 0; k < value.length(); k++) if ((value.charAt(k) < 32 && value.charAt(k) != '\t') || value.charAt(k) == 127) throw invalid();
            length |= name.equals("content-length"); encoding |= name.equals("transfer-encoding");
            physical.add(new HeadField(name, value, offset, offset + colon + 1, offset + line.length()));
            offset += line.length() + 2;
        }
        // prepareInputFilters removes CL from MimeHeaders in the ambiguous case,
        // but the bounded header window still retains its field name.
        if (length && encoding) throw invalid();
        if (physical.size() != normalized.size()) throw invalid();
        for (int i = 0; i < physical.size(); i++) {
            HeadField a = physical.get(i), b = normalized.get(i);
            if (!a.name.equalsIgnoreCase(b.name) || a.nameStart != b.nameStart || a.valueStart != b.valueStart || b.valueEnd < b.valueStart || b.valueEnd > a.valueEnd ||
                !text.substring(b.valueStart, b.valueEnd).equals(b.value)) throw invalid();
        }
        // OWS/folding compacts values. ByteChunk's exact span, not the old tail,
        // is authoritative. Visible continuation / misaligned names fail closed.
        // A fully overwritten fold is not claimed to be recoverable wire data.
    }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
