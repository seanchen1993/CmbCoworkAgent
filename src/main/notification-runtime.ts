import { initializeSystemNotificationChannel } from "./services/system-notification-channel"
import { initializeImHumanGateChannel } from "./services/im/human-gate-adapter"
import { initializeImBizRetryChannel } from "./services/im/biz-retry-adapter"
import { initializeHumanGateSource } from "./harness-board/human-gate-service"
import { initializeBizRetrySource } from "./harness-board/biz-retry-service"
import {
  failManagedRunForHumanGateConflict,
  recordManagedHumanGateDecision,
  resolveManagedBizRetryDecision
} from "./harness-board/auto-mode-controller"

/** Application composition root; call after storage setup and before notification recovery. */
export function initializeNotificationRuntime(): void {
  initializeHumanGateSource({
    recordDecision: recordManagedHumanGateDecision,
    failConflict: failManagedRunForHumanGateConflict
  })
  initializeBizRetrySource(resolveManagedBizRetryDecision)
  initializeSystemNotificationChannel()
  initializeImHumanGateChannel()
  initializeImBizRetryChannel()
}
