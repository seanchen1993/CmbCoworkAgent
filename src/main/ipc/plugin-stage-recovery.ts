import { z } from "zod"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginStageRecoveryScope } from "../../shared/mods/plugin-stage-recovery"
import type { PluginStageRecoverySessions } from "../mods/devtools/plugin-stage-recovery"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const caller = z.object({
  threadId: z.string().min(1).max(200),
  expectedWorkspace: z.string().min(1).max(4096)
})
const trial = caller.extend({
  trialId: z.string().regex(/^creator-business-trial:[a-f0-9-]{36}$/)
})
const operation = caller.extend({ preparationId: z.string().uuid(), expectedDigest: digest })

/** Renderer supplies identifiers and explicit consent only. Main resolves every source/path. */
export function registerPluginStageRecoveryHandlers(
  ipc: IpcMain,
  sessions: PluginStageRecoverySessions,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    normalizeWorkspace(workspace: string): string
    context(threadId: string): { scope: PluginStageRecoveryScope; assertCurrent(): void }
  }
) {
  function register<S extends z.ZodType>(
    action: string,
    schema: S,
    run: (scope: PluginStageRecoveryScope, input: z.output<S>, guard: () => void) => unknown
  ) {
    ipc.handle(`mods:development:plugin-stage-recovery:${action}`, async (event, raw: unknown) => {
      access.trusted(event)
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw Error("PLUGIN_STAGE_RECOVERY_INVALID_INPUT")
      const input = parsed.data as z.output<S> & { threadId: string; expectedWorkspace: string }
      const frame = event.sender.mainFrame
      const context = access.context(input.threadId)
      const guard = () => {
        access.trusted(event)
        if (event.sender.isDestroyed() || event.sender.mainFrame !== frame)
          throw Error("DEVELOPMENT_WINDOW_CHANGED")
        context.assertCurrent()
        if (context.scope.workspace !== access.normalizeWorkspace(input.expectedWorkspace))
          throw Error("PLUGIN_STAGE_RECOVERY_SCOPE_CHANGED")
      }
      guard()
      const result = await run(context.scope, input, guard)
      guard()
      return result
    })
  }
  register("inspect", trial.strict(), (scope, input, guard) =>
    sessions.inspect(scope, input.trialId, guard)
  )
  register("latest", trial.strict(), (scope, input, guard) =>
    sessions.latest(scope, input.trialId, guard)
  )
  register(
    "prepare",
    trial
      .extend({
        stageId: z.string().min(1).max(256),
        stateMode: z.enum(["target_in_progress", "previous_done"]),
        expectedPackageDigest: digest,
        expectedAdapterDigest: digest,
        expectedInputsDigest: digest,
        allowNetworkSideEffects: z.literal(true)
      })
      .strict(),
    (scope, input, guard) => {
      return sessions.prepare(
        {
          scope,
          trialId: input.trialId,
          stageId: input.stageId,
          stateMode: input.stateMode,
          expectedPackageDigest: input.expectedPackageDigest,
          expectedAdapterDigest: input.expectedAdapterDigest,
          expectedInputsDigest: input.expectedInputsDigest,
          allowNetworkSideEffects: input.allowNetworkSideEffects
        },
        guard
      )
    }
  )
  register(
    "apply",
    operation.extend({ allowNetworkSideEffects: z.literal(true) }).strict(),
    (scope, input, guard) =>
      sessions.apply(
        {
          scope,
          preparationId: input.preparationId,
          expectedDigest: input.expectedDigest,
          allowNetworkSideEffects: true
        },
        guard
      )
  )
  register(
    "reconcile",
    operation.extend({ allowNetworkSideEffects: z.literal(true).optional() }).strict(),
    (scope, input, guard) =>
      sessions.reconcile(
        {
          scope,
          preparationId: input.preparationId,
          expectedDigest: input.expectedDigest,
          ...(input.allowNetworkSideEffects ? { allowNetworkSideEffects: true as const } : {})
        },
        guard
      )
  )
}
