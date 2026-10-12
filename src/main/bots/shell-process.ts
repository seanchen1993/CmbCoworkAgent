import { AsyncLocalStorage } from "node:async_hooks"
import { BotDomainError } from "../../shared/bot-types"
import { safeSensitiveErrorText } from "../error-text"
import { BotOwnedShellProcess, type OwnedShellProcessOptions } from "./owned-shell-process"
import {
  botShellRequestSchema,
  type BotShellProgress,
  type BotShellRequest,
  type BotShellResult
} from "./shell-contract"

/** Trusted Host compiler supplies current ownership, immutable artifacts,
 * canonical platform policy and native capability. A model/request cannot
 * choose a backend, fallback, helper path, PID or resource ownership. */
export type BotShellOwnedFactory = ((
  request: BotShellRequest,
  signal: AbortSignal
) => Promise<OwnedShellProcessOptions>) & {
  /** Trusted Host preparation decides availability, never a request or environment flag. */
  readonly unavailableReason?: string
}
export type BotShellCurrentGuard = (signal: AbortSignal) => Promise<void>
export interface BotShellAdmission {
  admitted: Promise<void>
  completion: Promise<BotShellResult>
}

const preparationScope = new AsyncLocalStorage<object>()
/** One original approval's operation scope; background failures cannot borrow it. */
export function withBotShellPreparationScope<T>(
  scope: object,
  operation: () => Promise<T>
): Promise<T> {
  return preparationScope.run(scope, operation)
}

/** Local, trusted proof that dispatch never entered the owned resource start.
 * A matching remote code/message or a rejected admitted promise is not proof. */
export class BotShellPreparationError extends BotDomainError {
  private readonly scope = preparationScope.getStore()
  belongsTo(scope: object): boolean {
    return this.scope === scope
  }
  constructor(
    cause: unknown,
    readonly cancelled: boolean
  ) {
    super(
      cause instanceof BotDomainError ? cause.code : "shell_preparation_failed",
      safeSensitiveErrorText(
        cause instanceof Error ? cause.message : "命令准备失败，尚未运行",
        2000
      ),
      cause instanceof BotDomainError ? cause.diagnostic : undefined
    )
    this.name = "BotShellPreparationError"
    this.cause = cause
  }
}

export class BotShellProcess {
  constructor(private readonly owned?: BotShellOwnedFactory) {}

  get available(): boolean {
    return Boolean(this.owned) && !this.owned?.unavailableReason
  }

  assertAvailable(): void {
    if (!this.available)
      throw new BotDomainError(
        "shell_unavailable",
        this.owned?.unavailableReason ?? "Bot 命令隔离尚未准备完成，未运行命令"
      )
  }

  start(
    raw: BotShellRequest,
    signal: AbortSignal,
    progress?: (value: BotShellProgress) => void,
    current?: BotShellCurrentGuard
  ): BotShellAdmission {
    // Private control events run on native Socket/ChildProcess resources. Bind
    // the caller's scoped Notification/Hook authority before any await or event
    // registration, then revalidate that live authority on every guard call.
    const inCallerScope = AsyncLocalStorage.snapshot()
    let resolveAdmission!: () => void, rejectAdmission!: (error: unknown) => void
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve
      rejectAdmission = reject
    })
    void admitted.catch(() => {})
    const completion = (async () => {
      let request: BotShellRequest
      let prepared: OwnedShellProcessOptions
      try {
        signal.throwIfAborted()
        request = botShellRequestSchema.parse(raw)
        this.assertAvailable()
        prepared = await this.owned!(request, signal)
      } catch (error) {
        // Nothing below this boundary, including owned start/commit/admission,
        // may be reclassified: its lost ACK can follow a real external effect.
        throw new BotShellPreparationError(error, signal.aborted)
      }
      let released = false
      const process = new BotOwnedShellProcess({
        ...prepared,
        assertCurrent: (guardSignal) =>
          inCallerScope(async () => {
            await prepared.assertCurrent(guardSignal)
            await current?.(guardSignal)
            // The operation-specific guard may await configuration. Ownership
            // and pinned policy must remain current after that await too.
            await prepared.assertCurrent(guardSignal)
          }),
        releasePrepared: async (knownClosed) => {
          released = true
          await prepared.releasePrepared?.(knownClosed)
        }
      })
      try {
        const operation = process.start(request, signal, progress)
        void operation.admitted.then(resolveAdmission, rejectAdmission)
        return await operation.completion
      } finally {
        // executeOnce invokes releasePrepared even for uncertain resource
        // closure. If it did not, validation/guard failed before allocation or
        // spawning, and only Host-prepared disposable files need disposal.
        if (!released) await prepared.releasePrepared?.(true)
      }
    })()
    void completion.catch(rejectAdmission)
    return { admitted, completion }
  }

  execute(
    request: BotShellRequest,
    signal: AbortSignal,
    progress?: (value: BotShellProgress) => void,
    current?: BotShellCurrentGuard
  ): Promise<BotShellResult> {
    return this.start(request, signal, progress, current).completion
  }
}
