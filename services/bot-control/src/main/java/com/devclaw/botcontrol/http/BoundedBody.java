package com.devclaw.botcontrol.http;

import com.devclaw.botcontrol.application.Operation;
import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import java.io.*;
import java.util.function.LongSupplier;

final class BoundedBody {
    static final int MAX_BYTES = 1048576;
    private static final long DEADLINE_NS = 5000000000L;
    static byte[] read(InputStream input, Operation operation) { return read(input, operation, System::nanoTime); }
    // Package-private clock only for pure deadline tests, not a runtime mode.
    static byte[] read(InputStream input, Operation operation, LongSupplier clock) {
        long started = clock.getAsLong(); ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buffer = new byte[8192];
        try {
            while (true) {
                check(clock, started);
                int n = input.read(buffer);
                check(clock, started);
                if (n == -1) return out.toByteArray();
                if (!operation.write() && n > 0) throw invalid();
                if (out.size() + n > MAX_BYTES) throw new HttpFailure(ErrorCode.PAYLOAD_TOO_LARGE);
                out.write(buffer, 0, n);
            }
        } catch (HttpFailure failure) { throw failure; }
        catch (IOException failure) { throw invalid(); }
    }
    private static void check(LongSupplier clock, long started) { if (clock.getAsLong() - started >= DEADLINE_NS) throw invalid(); }
    private static HttpFailure invalid() { return new HttpFailure(ErrorCode.INVALID_PAYLOAD); }
}
