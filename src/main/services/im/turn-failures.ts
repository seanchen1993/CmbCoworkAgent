/**
 * IM turn failures that carry their own reason code.
 *
 * The IM runner maps a thrown error to a reason code by `instanceof`, and
 * anything unrecognized becomes REMOTE_RUNTIME_FAILED — a retryable-looking
 * generic failure. These two exist so a blocked turn does not read as a broken
 * one: the user is told their message was stopped by policy rather than that
 * the robot failed.
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
