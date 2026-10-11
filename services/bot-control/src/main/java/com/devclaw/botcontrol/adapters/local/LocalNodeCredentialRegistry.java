package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.contracts.BotContracts.ErrorCode;
import com.devclaw.botcontrol.domain.ApplicationFault;
import com.devclaw.botcontrol.ports.TrustedNodeContext;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.util.*;
import java.util.function.Function;

/** Trusted local configuration only, NOT a JSON/HTTP registration endpoint.
 * Independent random 256-bit credentials, no user bearer fallback. The registry
 * retains digests only. Sessions carry neither credentials nor caller identities.
 * Transport/TLS and private-file provisioning remain outside this slice. */
public final class LocalNodeCredentialRegistry {
    public static final class Binding {
        private final String space, node, owner, credential;
        private final Instant expiresAt;
        public Binding(String space, String node, String owner, String credential, Instant expiresAt) {
            this.space = space; this.node = node; this.owner = owner;
            this.credential = credential; this.expiresAt = expiresAt;
        }
        @Override public String toString() { return "NodeCredentialBinding[redacted]"; }
    }
    private static final class Entry {
        final TrustedNodeContext context; final byte[] digest; final Instant expiresAt;
        Entry(Binding b) {
            context = new TrustedNodeContext(b.space, b.node, b.owner);
            digest = digest(b.credential); expiresAt = b.expiresAt;
        }
    }
    /** Only authenticate can issue this handle. Not serializable as node identity. */
    public static final class Session {
        private final LocalNodeCredentialRegistry issuer; private final Entry entry;
        private Session(LocalNodeCredentialRegistry issuer, Entry entry) { this.issuer = issuer; this.entry = entry; }
        @Override public String toString() { return "NodeSession[redacted]"; }
    }
    private final Clock clock;
    private Map<List<String>, Entry> entries = Collections.emptyMap();
    public LocalNodeCredentialRegistry(Clock clock, List<Binding> bindings) {
        if (clock == null) throw invalid(); this.clock = clock; replace(bindings);
    }
    private static IllegalArgumentException invalid() { return new IllegalArgumentException("NODE_CREDENTIAL_CONFIG_INVALID"); }
    private static ApplicationFault unauthenticated() { return new ApplicationFault(ErrorCode.UNAUTHENTICATED); }
    private static boolean id(String value) { return value != null && value.length() <= 128 && value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*"); }
    private static List<String> key(String space, String node) { return Arrays.asList(space, node); }
    private static byte[] digest(String credential) {
        try { return MessageDigest.getInstance("SHA-256").digest(("devclaw-node-v1:" + credential).getBytes(StandardCharsets.US_ASCII)); }
        catch (Exception failure) { throw invalid(); }
    }
    /** Atomic trusted reload/rotation. Invalid reload preserves all old sessions;
     * successful reload invalidates ALL old sessions, even unchanged bindings. */
    public synchronized void replace(List<Binding> bindings) {
        if (bindings == null || bindings.size() > 16) throw invalid();
        Map<List<String>, Entry> next = new HashMap<List<String>, Entry>();
        Set<String> credentials = new HashSet<String>();
        Instant now = clock.instant();
        for (Binding b : bindings) {
            if (b == null || !id(b.space) || !id(b.node) || !id(b.owner)
                || b.credential == null || !b.credential.matches("dcn1_[a-f0-9]{64}")
                || b.expiresAt == null || b.expiresAt.getNano() % 1000000 != 0 || !now.isBefore(b.expiresAt)
                || !credentials.add(b.credential) || next.put(key(b.space, b.node), new Entry(b)) != null) throw invalid();
        }
        entries = Collections.unmodifiableMap(next);
    }
    public synchronized void revoke(String space, String node) {
        if (!id(space) || !id(node)) throw invalid();
        Map<List<String>, Entry> next = new HashMap<List<String>, Entry>(entries);
        next.remove(key(space, node)); entries = Collections.unmodifiableMap(next);
    }
    public synchronized Session authenticate(String authorization) {
        if (authorization == null || !authorization.matches("(?i:Bearer) dcn1_[a-f0-9]{64}")) throw unauthenticated();
        byte[] supplied = digest(authorization.substring(7)); Entry match = null;
        for (Entry entry : entries.values()) if (MessageDigest.isEqual(supplied, entry.digest)) match = entry;
        if (match == null || !clock.instant().isBefore(match.expiresAt)) throw unauthenticated();
        return new Session(this, match);
    }
    /** Recheck on EVERY node call. Local revocation/reload is serialized with
     * admission; it cannot stop already admitted external effects. App services
     * still recheck current membership/grants/versions in their transactions. */
    public synchronized <T> T use(Session session, Function<TrustedNodeContext, T> operation) {
        if (session == null || session.issuer != this
            || entries.get(key(session.entry.context.spaceId, session.entry.context.nodeId)) != session.entry
            || !clock.instant().isBefore(session.entry.expiresAt)) throw unauthenticated();
        if (operation == null) throw invalid();
        return operation.apply(session.entry.context);
    }
    @Override public String toString() { return "LocalNodeCredentialRegistry[redacted]"; }
}
