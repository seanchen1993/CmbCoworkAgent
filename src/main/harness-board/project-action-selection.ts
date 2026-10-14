import { parseClawProfile } from "../../shared/mods/claw"
import type { ClawActionDescriptor } from "../../shared/mods/claw-actions"
import type { ProjectActionBinding } from "../../shared/project-runtime/action-bindings"
import { ClawStore } from "../mods/claw-store"
import { assertProjectActionProviders } from "./project-runtime/action-input"

/** A host-admitted selection only; the existing manager still checks every provider grant. */
export async function prepareProjectActionSelection(
  workspace: string,
  threadId: string,
  bindings: readonly ProjectActionBinding[],
  host: {
    store: ClawStore
    assertScope(): string
    catalog(workspace: string, threadId: string): Promise<ClawActionDescriptor[]>
    closeThread(threadId: string): void
  }
): Promise<void> {
  const identity = host.assertScope()
  const captured = structuredClone([...bindings])
  const catalog = await host.catalog(workspace, threadId)
  if (host.assertScope() !== identity) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
  assertProjectActionProviders(
    { apiVersion: "devclaw.project-actions-lock/v1", bindings: captured },
    catalog
  )
  const current = host.store.selection(workspace, identity).profile
  const capabilities = [
    ...new Map(
      captured.map(({ ref }) => [
        ref.pluginId,
        {
          pluginId: ref.pluginId,
          name: ref.plugin,
          digest: ref.digest
        }
      ])
    ).values()
  ]
  const profile = parseClawProfile({
    ...current,
    id: "project-host-actions",
    name: "项目公开动作",
    capabilities
  })
  const revision = host.store.read(workspace).revision
  if (host.assertScope() !== identity) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
  // No await between the scope fence, closing only this thread, and its atomic binding write.
  // Closing also clears FunctionModsManager's cached selection from the preceding Skill phase.
  host.closeThread(threadId)
  host.store.apply(workspace, identity, profile, revision)
}
