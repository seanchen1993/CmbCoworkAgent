import { BotClientRegistry } from "../../../../shared/bots/client-registry"
import { LOCAL_BOT_HOST_ID } from "../../../../shared/bots/contracts"

const hosts = new BotClientRegistry()
let localRegistered = false
export function localBotClient() {
  if (!localRegistered) {
    hosts.register(window.api.bots)
    localRegistered = true
  }
  return hosts.get(LOCAL_BOT_HOST_ID)
}
