import { createRoot } from "react-dom/client"
import { BotsWorkspace } from "../../src/renderer/src/components/bots/BotsWorkspace"
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip"
import { useBotViewStore } from "../../src/renderer/src/components/bots/view-store"
import { SERVICE_EXPERT_SELECTION } from "../../src/renderer/src/components/bots/useServiceExpertChats"
import type { BotClient } from "../../src/shared/bots/contracts"
useBotViewStore.getState().update("local", { selectedId: SERVICE_EXPERT_SELECTION, groupId: null })
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <BotsWorkspace client={(window as any).fixtureLocalBot as BotClient} />
  </TooltipProvider>
)
