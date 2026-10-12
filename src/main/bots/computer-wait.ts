import { setTimeout as delay } from "node:timers/promises"
import type { LocalBotComputerProvider } from "./computer-provider"
import type { BotRuntimeRequest } from "./host"
import type { BotBrowserTarget } from "../../shared/bot-computer"

/** Waiting uses the existing durable waiting_input/lease path, freeing a Host
 * execution slot while retaining this Bot's serial task ownership. No action is
 * replayed here: the caller must discard stale element references after handback.
 */
export async function waitForBotComputer(
  request: BotRuntimeRequest,
  computer: LocalBotComputerProvider,
  otherComputerHeld: () => boolean = () => false
): Promise<boolean> {
  const taskRunId =
    request.store.workflowChildren.metadata(request.run.id)?.input.browserAccess === "page"
      ? request.run.id
      : undefined
  let broker = await computer.get()
  await broker.ensure(request.bot.id, taskRunId)
  let waited = false
  while (broker.target(request.bot.id, taskRunId).control !== "bot" || otherComputerHeld()) {
    request.signal.throwIfAborted()
    request.store.steering.interruptIfPending(request.lease)
    request.store.waitForComputer(request.lease, true)
    waited = true
    await delay(250, undefined, { signal: request.signal })
    const next = await computer.get()
    if (next !== broker) {
      broker = next
      await broker.ensure(request.bot.id, taskRunId)
    }
  }
  request.signal.throwIfAborted()
  if (waited) request.store.waitForComputer(request.lease, false)
  return waited || broker.requiresObservation(request.bot.id, taskRunId)
}

export const BOT_COMPUTER_REOBSERVE =
  "The browser was rebuilt, resized, or its control was handed back. This tool action was NOT performed. Take a fresh browser snapshot before choosing your next action; old element references, page assumptions and approvals are no longer valid. Do not repeat an uncertain external action."

/** An approval cannot survive a transfer or a rebuilt page. Return a tool result
 * before the effect receipt starts; never apply an old approval to the new target.
 */
export async function prepareApprovedBotComputer(
  request: BotRuntimeRequest,
  computer: LocalBotComputerProvider,
  expected: BotBrowserTarget
): Promise<string | void> {
  const taskRunId =
    request.store.workflowChildren.metadata(request.run.id)?.input.browserAccess === "page"
      ? request.run.id
      : undefined
  const broker = await computer.get()
  const current = await broker.ensure(request.bot.id, taskRunId)
  if (
    current.taskRunId === expected.taskRunId &&
    current.control === "bot" &&
    current.generation === expected.generation &&
    current.controlEpoch === expected.controlEpoch &&
    current.viewId === expected.viewId
  )
    return
  await waitForBotComputer(request, computer)
  return BOT_COMPUTER_REOBSERVE
}
