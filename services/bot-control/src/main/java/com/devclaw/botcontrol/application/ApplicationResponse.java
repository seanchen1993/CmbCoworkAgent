package com.devclaw.botcontrol.application;

import java.util.Arrays;

public final class ApplicationResponse {
    public final int status;
    private final byte[] body;
    public ApplicationResponse(int status, byte[] body) { this.status = status; this.body = Arrays.copyOf(body, body.length); }
    public byte[] body() { return Arrays.copyOf(body, body.length); }
}
