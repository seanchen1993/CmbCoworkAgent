import { z } from "zod"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import type { CreatorBusinessService } from "../mods/devtools/creator-business"
import type { ModDevelopmentService } from "../mods/devtools/development-service"
import { registerNativeProjectSourceHandlers } from "./native-project-source"

const author = z.object({
  threadId: z.string().min(1).max(200),
  expectedWorkspace: z.string().min(1).max(4096)
})
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const scope = author.extend({
  trialId: z.string().regex(/^creator-business-trial:[a-f0-9-]{36}$/),
  digest,
  expectedVersion: z.number().int().min(1)
})

/** Native-only requests. No model-supplied path, source, project, token or permission flag. */
export function registerCreatorBusinessTrialHandlers(
  ipc: IpcMain,
  business: CreatorBusinessService,
  development: ModDevelopmentService,
  trusted: (event: IpcMainInvokeEvent) => void,
  window: () => BrowserWindow | null | undefined
) {
  const prefix = "mods:development:business-trial"
  const register = <S extends z.ZodType>(
    name: string,
    schema: S,
    run: (input: z.output<S>) => unknown
  ) => {
    ipc.handle(`${prefix}:${name}`, (_event, raw: unknown) => {
      trusted(_event)
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw Error("BUSINESS_TRIAL_INVALID_INPUT")
      return run(parsed.data)
    })
  }
  const owner = () => {
    const value = window()
    if (!value || value.isDestroyed()) throw Error("DEVELOPMENT_WINDOW_CHANGED")
    return value
  }
  register(
    "request",
    author
      .extend({ planId: z.string().uuid(), digest, goal: z.string().trim().min(1).max(8000) })
      .strict(),
    async (input) => {
      await business.requestTrial(input.threadId, input.expectedWorkspace, input)
      return development.status(input.threadId)
    }
  )
  for (const name of ["prepare", "refresh", "start", "stop"] as const) {
    register(name, scope.strict(), async (input) => {
      const trials = business.trialService()
      if (name === "start") await trials.start(input, owner())
      else await trials[name](input)
      return development.status(input.threadId)
    })
  }
  register("context", scope.strict(), (input) => business.trialService().context(input))
  register(
    "select-context",
    scope
      .extend({
        selection: z
          .object({
            contextFingerprint: digest,
            deployUnitIds: z.array(z.string().min(1).max(512)).max(128)
          })
          .strict()
      })
      .strict(),
    async (input) => {
      await business.trialService().selectContext(input)
      return development.status(input.threadId)
    }
  )
  register("gates", scope.strict(), (input) => business.trialService().gates(input))
  register(
    "decide-gate",
    scope
      .extend({
        notificationId: z.string().min(1).max(256),
        action: z.enum(["approve", "reject"]),
        message: z.string().max(4000).optional()
      })
      .strict(),
    async (input) => {
      await business.trialService().decideGate(input, owner())
      return development.status(input.threadId)
    }
  )
  register(
    "feedback",
    scope.extend({ message: z.string().trim().min(1).max(4000) }).strict(),
    (input) => {
      business.trialService().feedback(input)
      return development.status(input.threadId)
    }
  )
  registerNativeProjectSourceHandlers(ipc, prefix, (event, trialId) => {
    trusted(event)
    const source = business.trialService().source(trialId),
      frame = event.sender.mainFrame
    const assertSender = () => {
      trusted(event)
      if (event.sender.isDestroyed() || event.sender.mainFrame !== frame)
        throw Error("DEVELOPMENT_WINDOW_CHANGED")
    }
    return {
      ...source,
      guard: () => {
        assertSender()
        source.guard()
        assertSender()
      },
      authorityGuard: () => {
        assertSender()
        source.authorityGuard()
        assertSender()
      }
    }
  })
}
