/**
 * IM turn failures that carry their own reason code.
 *
 * The IM runner maps a thrown error to a reason code by `instanceof`, and
 * anything unrecognized becomes REMOTE_RUNTIME_FAILED — a retryable-looking
 * generic failure whose reply is a short code and nothing else. These exist so
 * that a turn which was stopped, or which ran but did not finish, does not read
 * as a broken robot: the user is told what actually happened.
 *
 * They live apart from remote-runner so the shared result collector can throw
 * them without importing the runner that catches them.
 */

/** The input never reached the model: an explicit-skill check or UserPromptSubmit hook stopped it. */
export class ImPreparedPromptRejectedError extends Error {
  readonly reasonCode = "REMOTE_PROMPT_BLOCKED"
}

/** The turn ran, but a completion (Stop) hook refused to let it finish. */
export class ImCompletionHookRejectedError extends Error {
  readonly reasonCode = "REMOTE_COMPLETION_HOOK_BLOCKED"
}

/**
 * The turn ran and did not crash, but must not be reported as complete: a Stop
 * hook halted it, a goal was blocked, or the turn-completion gate found an
 * unresolved protocol defect / open todos. The run body reports all of these
 * under one terminal code on purpose, so this class covers the same set.
 *
 * Never retryable. Re-running spends another model call on a turn that already
 * had its bounded retries inside the gate, and the two other producers are
 * policy decisions that would simply repeat.
 */
export class ImTurnIncompleteError extends Error {
  readonly reasonCode = "REMOTE_TURN_INCOMPLETE"
}
