import { BotEnvironmentMaintenance } from "./BotEnvironmentMaintenance"
export function BotWorkspaceMaintenance({ close }: { close(): void }) {
  return <BotEnvironmentMaintenance kind="workspace" close={close} />
}
