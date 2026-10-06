package com.devclaw.botcontrol.ports;

/** Supplied by a trusted adapter, never deserialized from request bytes. */
public final class TrustedContext {
    public final String spaceId, principalId;
    public TrustedContext(String spaceId, String principalId) { this.spaceId = spaceId; this.principalId = principalId; }
}
