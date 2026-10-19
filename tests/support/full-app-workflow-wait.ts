import { setTimeout as delay } from "node:timers/promises"

/** Await only the original observed terminal; failure cleanup cancels this fixture's own timer. */
export async function waitForOriginalWorkflowTerminal<T>(input: {
  readTerminal: () => T | undefined
  deadline: number
  signal: AbortSignal
  observe: () => void
}): Promise<T | undefined> {
  input.signal.throwIfAborted()
  while (!input.readTerminal() && Date.now() < input.deadline) {
    input.signal.throwIfAborted()
    input.observe()
    await delay(50, undefined, { signal: input.signal })
    input.signal.throwIfAborted()
  }
  input.signal.throwIfAborted()
  return input.readTerminal()
}
