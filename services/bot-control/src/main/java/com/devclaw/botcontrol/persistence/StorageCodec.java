package com.devclaw.botcontrol.persistence;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Internal representation only, not a replacement for ContractBoundary.
 * Names escape every non-ASCII UTF16 code unit incl lone surrogates/NUL.
 * Original bounded config/receipt JSON bytes go to MEDIUMBLOB unchanged. */
public final class StorageCodec {
    private static final ObjectMapper MAPPER = new ObjectMapper().enable(JsonGenerator.Feature.ESCAPE_NON_ASCII).enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private StorageCodec() {}
    public static String encodeName(String value) {
        try {
            if (value == null) throw new IllegalArgumentException();
            String encoded = MAPPER.writeValueAsString(value);
            if (encoded.length() > 3074 || !StandardCharsets.US_ASCII.newEncoder().canEncode(encoded)) throw new IllegalArgumentException();
            return encoded;
        } catch (Exception e) { throw new DatabaseFailure(DatabaseFailure.Category.STORAGE_INVALID); }
    }
    public static String decodeName(String encoded) {
        try {
            if (encoded == null || encoded.length() > 3074) throw new IllegalArgumentException();
            JsonNode n = MAPPER.readTree(encoded);
            if (!n.isTextual()) throw new IllegalArgumentException();
            return n.textValue();
        } catch (Exception e) { throw new DatabaseFailure(DatabaseFailure.Category.STORAGE_INVALID); }
    }
    public static byte[] boundedBody(byte[] bytes) {
        if (bytes == null || bytes.length > 1048576) throw new DatabaseFailure(DatabaseFailure.Category.STORAGE_INVALID);
        return Arrays.copyOf(bytes, bytes.length);
    }
}
