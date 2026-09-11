import { homedir } from "os"
import { join, resolve } from "path"

/**
 * Resolve CmbCowork's application-managed data root without creating it.
 * Keep every store on this one contract so portable/custom-home deployments do
 * not split one thread's data between the configured root and the user home.
 */
export function getCmbCoworkAgentDataRoot(): string {
  const configured = process.env.CMB_COWORK_AGENT_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), ".cmbcoworkagent")
}
