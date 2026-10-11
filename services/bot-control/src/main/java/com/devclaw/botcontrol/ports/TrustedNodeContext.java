package com.devclaw.botcontrol.ports;

/** Supplied only by an authenticated, node-bound credential adapter (not JSON).
 * Transport and credential rotation are deliberately outside this local slice. */
public final class TrustedNodeContext {
    public final String spaceId, nodeId, ownerPrincipalId;
    public TrustedNodeContext(String spaceId, String nodeId, String ownerPrincipalId) {
        this.spaceId = spaceId; this.nodeId = nodeId; this.ownerPrincipalId = ownerPrincipalId;
    }
}
