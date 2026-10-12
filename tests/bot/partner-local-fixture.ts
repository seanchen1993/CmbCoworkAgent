import type { PartnerConnectionDescriptor } from "../../src/main/services/bot/partner-local-client"
export function descriptor(port = 32123): PartnerConnectionDescriptor {
  return {
    version: 1,
    url: `http://127.0.0.1:${port}`,
    spaceId: "A",
    nodeId: "node",
    ownerPrincipalId: "owner",
    businessPrincipalId: "business",
    workspaceRef: "view",
    ownerToken: "a".repeat(64),
    businessToken: "b".repeat(64),
    nodeToken: "dcn1_" + "c".repeat(64)
  }
}
