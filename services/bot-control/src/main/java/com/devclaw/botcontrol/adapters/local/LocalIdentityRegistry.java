package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.contracts.BotContracts.Capability;
import com.devclaw.botcontrol.ports.*;
import com.devclaw.botcontrol.validation.ContractBoundary;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import static com.devclaw.botcontrol.adapters.local.LocalLaunchConfig.*;

/** Immutable trusted policy; bearer resolves ONLY the principal, not the space. */
public final class LocalIdentityRegistry implements IdentityPolicy {
    private static final ContractBoundary IDS = new ContractBoundary();
    private static final class Space {
        final boolean member, botCreate, groupCreate;
        final Set<String> knowledge, repositories, skills;
        final Set<Capability> ceiling;
        Space(JsonNode n) {
            fields(n, "spaceId", "member", "canCreateBot", "canCreateGroup", "knowledgeRefs", "repositoryRefs", "skillAllowlist", "capabilityCeiling");
            member = bool(n.get("member")); botCreate = bool(n.get("canCreateBot")); groupCreate = bool(n.get("canCreateGroup"));
            knowledge = ids(n.get("knowledgeRefs")); repositories = ids(n.get("repositoryRefs")); skills = ids(n.get("skillAllowlist"));
            JsonNode values = n.get("capabilityCeiling"); array(values, Capability.values().length);
            Set<Capability> caps = new HashSet<Capability>(); for (JsonNode v : values) if (!caps.add(Capability.fromWire(string(v)))) throw invalid();
            ceiling = Collections.unmodifiableSet(caps);
            if (!member && (botCreate || groupCreate || !knowledge.isEmpty() || !repositories.isEmpty() || !skills.isEmpty() || !ceiling.isEmpty())) throw invalid();
        }
    }
    private static final class Principal {
        final boolean active; final Map<String, Space> spaces;
        Principal(JsonNode n) {
            fields(n, "principalId", "active", "spaces"); active = bool(n.get("active"));
            JsonNode entries = n.get("spaces"); array(entries, 16); Map<String, Space> values = new HashMap<String, Space>();
            for (JsonNode space : entries) { Space value = new Space(space); if (values.put(id(space.get("spaceId")), value) != null) throw invalid(); }
            spaces = Collections.unmodifiableMap(values);
        }
    }
    private final Map<String, Principal> principals;
    private final Map<String, byte[]> bearers;
    private LocalIdentityRegistry(Map<String, Principal> principals, Map<String, byte[]> bearers) { this.principals = Collections.unmodifiableMap(principals); this.bearers = Collections.unmodifiableMap(bearers); }
    static LocalIdentityRegistry parse(JsonNode n) {
        fields(n, "principals", "bearers"); array(n.get("principals"), 16); array(n.get("bearers"), 16);
        if (n.get("principals").size() == 0) throw invalid();
        Map<String, Principal> principals = new HashMap<String, Principal>();
        for (JsonNode p : n.get("principals")) if (principals.put(id(p.get("principalId")), new Principal(p)) != null) throw invalid();
        Map<String, byte[]> bearers = new HashMap<String, byte[]>(); Set<String> unique = new HashSet<String>();
        for (JsonNode b : n.get("bearers")) {
            fields(b, "token", "principalId"); String principal = id(b.get("principalId")), token = string(b.get("token"));
            if (!token.matches("[a-f0-9]{64}") || !principals.containsKey(principal) || !unique.add(token) || bearers.put(principal, token.getBytes(StandardCharsets.US_ASCII)) != null) throw invalid();
        }
        if (!principals.keySet().equals(bearers.keySet())) throw invalid();
        return new LocalIdentityRegistry(principals, bearers);
    }
    private static String id(JsonNode value) { return IDS.validateParameter("getBot", "botId", string(value)); }
    private static Set<String> ids(JsonNode n) { array(n, 64); Set<String> result = new HashSet<String>(); for (JsonNode value : n) if (!result.add(id(value))) throw invalid(); return Collections.unmodifiableSet(result); }
    public String principalFor(String authorization) {
        if (authorization == null || !authorization.matches("(?i:Bearer) [a-f0-9]{64}")) return null;
        byte[] token = authorization.substring(7).getBytes(StandardCharsets.US_ASCII); String principal = null;
        for (Map.Entry<String, byte[]> entry : bearers.entrySet()) if (MessageDigest.isEqual(token, entry.getValue())) principal = entry.getKey();
        return principal;
    }
    private Space scope(String space, String principal) { Principal p = principals.get(principal); if (p == null || !p.active) return null; Space s = p.spaces.get(space); return s != null && s.member ? s : null; }
    private Space scope(TrustedContext actor) { return actor == null ? null : scope(actor.spaceId, actor.principalId); }
    @Override public boolean activeMember(String space, String principal) { return scope(space, principal) != null; }
    @Override public boolean mayCreateBot(TrustedContext actor) { Space s = scope(actor); return s != null && s.botCreate; }
    @Override public boolean mayCreateGroup(TrustedContext actor) { Space s = scope(actor); return s != null && s.groupCreate; }
    @Override public boolean mayAssociate(TrustedContext actor, Reference kind, String id) { Space s = scope(actor); if (s == null || kind == null) return false; switch (kind) { case KNOWLEDGE: return s.knowledge.contains(id); case REPOSITORY: return s.repositories.contains(id); case SKILL: return s.skills.contains(id); default: return false; } }
    @Override public boolean mayConfigure(TrustedContext actor, Capability capability) { Space s = scope(actor); return s != null && s.ceiling.contains(capability); }
    @Override public String toString() { return "LocalIdentityRegistry[immutable]"; }
}
