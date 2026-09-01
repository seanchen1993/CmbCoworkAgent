import {
  handleAutoModeAgentTurnEnd,
  startManagedRun,
  stopManagedRun,
  type AutoModeAgentTurnEndInput,
  type ManagedRunStartRequest
} from "./auto-mode-controller"
import type { ManagedRunStopInput, ManagedRunSummary } from "../../shared/harness-board-types"

/** Durable V2 Controller facade. The V1-named module remains the runtime adapter for Agent IPC. */
export class ManagedRunController {
  start(input: ManagedRunStartRequest): Promise<ManagedRunSummary> {
    return startManagedRun(input)
  }

  stop(input: ManagedRunStopInput): Promise<boolean> {
    return stopManagedRun(input)
  }

  handleAgentTurnEnd(input: AutoModeAgentTurnEndInput): Promise<void> {
    return handleAutoModeAgentTurnEnd(input)
  }
}

export const managedRunController = new ManagedRunController()
