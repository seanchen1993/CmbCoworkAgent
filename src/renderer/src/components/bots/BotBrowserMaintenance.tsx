import { BotEnvironmentMaintenance } from "./BotEnvironmentMaintenance"
export function BotBrowserMaintenance({ close }: { close(): void }) {
  return <BotEnvironmentMaintenance kind="browser" close={close} />
}
