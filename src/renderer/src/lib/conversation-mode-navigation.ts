import { useAppStore } from "@/lib/store"

export function openConversationMode(): void {
  const state = useAppStore.getState()
  if (state.mainView !== "thread") {
    state.closeWorkerFocusView()
    state.closeSubagentFocusView()
    state.closeWorkflowAgentFocusView()
  }
  state.setMainView("thread")
}
