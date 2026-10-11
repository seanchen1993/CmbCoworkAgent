package com.devclaw.botcontrol.adapters.local;

import com.devclaw.botcontrol.application.RequirementRunApplication;
import com.devclaw.botcontrol.application.RuntimeNodeApplication;
import com.devclaw.botcontrol.contracts.BotContracts.Capability;
import com.devclaw.botcontrol.persistence.JdbcRequirementRunStore.Run;
import com.devclaw.botcontrol.persistence.JdbcRuntimeNodeStore.Node;
import java.util.Set;

/** Internal adapter seam for a future authenticated transport. No listener is
 * opened and no client-supplied node/space/owner is accepted. Claim remains a
 * control ticket, NOT permission to start AgentRunService or tools. */
public final class LocalAuthenticatedNodeAdapter {
    private final LocalNodeCredentialRegistry credentials;
    private final RuntimeNodeApplication nodes;
    private final RequirementRunApplication runs;
    public LocalAuthenticatedNodeAdapter(LocalNodeCredentialRegistry credentials, RuntimeNodeApplication nodes, RequirementRunApplication runs) {
        if (credentials == null || nodes == null || runs == null) throw new IllegalArgumentException("NODE_ADAPTER_CONFIG_INVALID");
        this.credentials = credentials; this.nodes = nodes; this.runs = runs;
    }
    public LocalNodeCredentialRegistry.Session authenticate(String authorization) { return credentials.authenticate(authorization); }
    public Node observe(LocalNodeCredentialRegistry.Session session, boolean supportsRequirement, Set<Capability> capabilities) {
        return credentials.use(session, context -> nodes.observeDesktopNode(context, supportsRequirement, capabilities));
    }
    public Run claim(LocalNodeCredentialRegistry.Session session, String runId) {
        return credentials.use(session, context -> runs.claimRequirementRun(context, runId));
    }
}
