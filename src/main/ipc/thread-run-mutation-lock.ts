import { AsyncKeyedLock } from "./async-keyed-lock"

const threadRunMutationLock = new AsyncKeyedLock()

export function withThreadRunMutationLock<T>(
  threadId: string,
  operation: () => Promise<T>
): Promise<T> {
  return threadRunMutationLock.withKey(threadId, operation)
}
