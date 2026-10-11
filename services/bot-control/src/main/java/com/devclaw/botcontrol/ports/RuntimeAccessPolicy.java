package com.devclaw.botcontrol.ports;

import com.devclaw.botcontrol.contracts.BotContracts.Capability;

/** Current execution/workspace ACL, separate from IdentityPolicy.mayConfigure.
 * A workspace reference denotes a task-isolated read-only view, never a host path.
 * Future adapters must recheck ACLs at actual Run start; this port grants no lease. */
public interface RuntimeAccessPolicy {
    boolean mayUseCapability(TrustedContext actor, Capability capability);
    boolean mayUseWorkspace(TrustedContext actor, String workspaceRef);
}
