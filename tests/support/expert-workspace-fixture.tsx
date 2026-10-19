import { createRoot } from "react-dom/client"
import { BotsWorkspace } from "../../src/renderer/src/components/bots/BotsWorkspace"
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip"
import { useBotViewStore } from "../../src/renderer/src/components/bots/view-store"
import { SERVICE_EXPERT_SELECTION } from "../../src/renderer/src/components/bots/useServiceExpertChats"
import type { BotClient } from "../../src/shared/bots/contracts"
useBotViewStore.getState().update("local", { selectedId: SERVICE_EXPERT_SELECTION, groupId: null })
let root = createRoot(document.getElementById("root")!)
const render = () =>
  root.render(
    <TooltipProvider>
      <BotsWorkspace client={(window as any).fixtureLocalBot as BotClient} />
    </TooltipProvider>
  )
;(window as any).remountM04 = () => {
  root.unmount()
  root = createRoot(document.getElementById("root")!)
  render()
}
render()
