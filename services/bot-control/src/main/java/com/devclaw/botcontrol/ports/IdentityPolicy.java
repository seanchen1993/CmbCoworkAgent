package com.devclaw.botcontrol.ports;

import com.devclaw.botcontrol.contracts.BotContracts.Capability;

/** Trusted local registry boundary. No resource fetching or ambient credentials. */
public interface IdentityPolicy {
    enum Reference { KNOWLEDGE, REPOSITORY, SKILL }
    boolean activeMember(String spaceId, String principalId);
    boolean mayCreateBot(TrustedContext actor);
    boolean mayCreateGroup(TrustedContext actor);
    boolean mayAssociate(TrustedContext actor, Reference kind, String referenceId);
    boolean mayConfigure(TrustedContext actor, Capability capability);
}
