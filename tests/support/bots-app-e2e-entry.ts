// Only included by the isolated App test build. Shared Rollup chunks keep the
// exact production host singleton used by the renderer's real IPC handlers.
export { getLocalBotHost } from "../../src/main/bots/local-service"
export { BotImChannelService } from "../../src/main/services/im/bot-channel-service"
export { ImGatewayWsClient } from "../../src/main/services/im/gateway-ws-client"
