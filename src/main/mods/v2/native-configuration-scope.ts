import { AsyncLocalStorage } from "node:async_hooks"
import type { ModPluginSource } from "../manager"
import { withSnapshotPathRetention } from "../../harness-board/project-runtime/snapshot-retention"

/** Main-only editor source. This supplies no execution grant and cannot be issued by a model. */
export interface NativeConfigurationScope {
  workspace: string
  projectId: string
  plugin: ModPluginSource
  /** Cheap native frame, project, owner and source identity check. No execution grant. */
  assertCurrent(): void
  /** Fresh complete package validation at actual configuration/await/publication boundaries. */
  assertContentCurrent(): void
}
const scopes = new AsyncLocalStorage<NativeConfigurationScope>()
export function currentNativeConfigurationScope() {
  const scope = scopes.getStore()
  scope?.assertCurrent()
  return scope
}
export function withNativeConfigurationScope<T>(scope: NativeConfigurationScope, work: () => T): T {
  scope.assertCurrent()
  return withSnapshotPathRetention([scope.plugin.path], () => scopes.run(scope, work))
}
