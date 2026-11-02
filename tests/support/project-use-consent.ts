import { join } from "node:path"
import type { HarnessProjectCreateInput } from "../../src/shared/harness-board-types"
import type { PluginMetadata } from "../../src/main/types"
import type { HarnessProjectUseReview } from "../../src/shared/project-use-authorization"
import { testSecretProtector } from "./mods-secret-protector"

/** Real owner receipt/manager/providers; no Guest runs during static project admission. */
export async function projectUseConsentFixture(root: string, plugins: () => PluginMetadata[]) {
  const [{ ModsManager }, { FunctionModsManager }, authority, service, native] = await Promise.all([
    import("../../src/main/mods/manager"),
    import("../../src/main/mods/v2/manager"),
    import("../../src/main/harness-board/project-use-authorization"),
    import("../../src/main/harness-board/service"),
    import("../../src/main/harness-board/native-harness")
  ])
  let application = false
  let applicationEpoch = 0
  let guestLoads = 0
  const core = new ModsManager(
    join(root, "project-use-control.sqlite"),
    () => [],
    async () => false,
    () => {},
    undefined,
    undefined,
    () => application
  )
  const { store } = core
  const manager = new FunctionModsManager(
    store,
    {
      plugins,
      secretProtector: {
        ...testSecretProtector(),
        getSelectedStorageBackend: () => "gnome_libsecret"
      },
      enabled: (workspace) => core.isEnabled(workspace),
      publish: async (_, value) => value,
      changed: () => {}
    },
    () => ({
      load: async () => {
        guestLoads++
        throw Error("PROJECT_ADMISSION_MUST_NOT_LOAD_GUEST")
      },
      stop: () => {}
    })
  )
  authority.configureProjectUseAuthority({
    parent: service.readHarnessProjectUseParent,
    child: native.findNativeHarnessFeatureByRunId,
    assertChild: service.assertHarnessProjectUseChild
  })
  authority.configureProjectUseRuntime({
    manager,
    store,
    workspaceKey: (value) => core.workspaceKey(value),
    control: {
      applicationStamp: () => JSON.stringify([application, applicationEpoch]),
      settingsStamp: (workspace) =>
        JSON.stringify(
          ["enabled", "policy", "epoch"].map((key) => store.getSetting(`${key}:${workspace}`, ""))
        ),
      globallyEnabled: () => core.isGloballyEnabled(),
      enabled: (workspace) => core.isEnabled(workspace),
      enableApplication: () => {
        application = true
        applicationEpoch++
      },
      enable: (workspace) => core.configure(workspace, true, false),
      initialize: (workspace) => {
        const key = core.workspaceKey(workspace)
        if (!store.getSetting(`enabled:${key}`, "")) core.configure(key, true, false)
      }
    }
  })
  const owner = {}
  const review = (input: HarnessProjectCreateInput) =>
    authority.reviewProjectUse(
      {
        adapterId: input.adapterId,
        adapterType: "plugin",
        workspacePath: input.workspacePath,
        projectDir: input.projectDir,
        expectedNativeTemplate: input.expectedNativeTemplate
      },
      owner
    )
  const createReviewed = (input: HarnessProjectCreateInput, reviewed: HarnessProjectUseReview) =>
    service.createHarnessProject(
      {
        ...input,
        projectUseApproval: {
          reviewId: reviewed.reviewId,
          reviewDigest: reviewed.reviewDigest
        }
      },
      undefined,
      owner
    )
  return {
    manager,
    store,
    core,
    review,
    createReviewed,
    guestLoads: () => guestLoads,
    async create(input: HarnessProjectCreateInput) {
      return createReviewed(input, await review(input))
    },
    close() {
      manager.close()
      core.close()
    }
  }
}
