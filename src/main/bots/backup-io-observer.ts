import { AsyncLocalStorage } from "node:async_hooks"

interface BackupIoObserver {
  assertCurrent(): void
  worked(bytes: number): void
  git?(active: boolean): void
  fatalAbort?(): never
}
const observers = new AsyncLocalStorage<BackupIoObserver>()

/** One serial maintenance operation can observe the existing byte primitives
 * without adding counters to every manifest/copy API. The scope also survives
 * nested verification passes; callbacks represent completed work, not timers. */
export function withBackupIoObserver<T>(observer: BackupIoObserver, operation: () => Promise<T>) {
  return observers.run(observer, operation)
}
export function assertBackupIoCurrent(): void {
  observers.getStore()?.assertCurrent()
}
export function observedBackupIo(bytes = 0): void {
  const observer = observers.getStore()
  if (!observer) return
  observer.assertCurrent()
  observer.worked(bytes)
}
export function observedBackupGit(active: boolean): void {
  observers.getStore()?.git?.(active)
}
/** A still-running native subprocess must not outlive the lock owner. The
 * supervised launcher terminates its whole process group/Windows Job when
 * this owning process exits. Do not release the lock over an active writer. */
export function abortBackupIoProcess(): never {
  return observers.getStore()?.fatalAbort?.() ?? process.exit(1)
}
