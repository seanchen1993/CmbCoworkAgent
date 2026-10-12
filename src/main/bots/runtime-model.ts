import { createHash } from "node:crypto"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { canonicalJson } from "./validation"

type Model = BotModelSnapshot["models"][number]
const identity = (model: Model) => {
  const configuration = Object.fromEntries(Object.entries(model).filter(([key]) => key !== "name"))
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex")
}
const changed = () =>
  new BotDomainError(
    "model_configuration_changed",
    "任务所用模型配置已变化，请检查设置后重新发起任务"
  )

/** Pin the provider on its first actual request, using the existing durable
 * operation ledger. Recovery must not silently send old context to a new model.
 * Call inside the retry boundary and before reserving/sending each attempt. */
export function botTaskModelGuard(
  request: BotRuntimeRequest,
  modelFile: string,
  requestedRef: string | null,
  config: Model
): () => Promise<void> {
  const fingerprint = identity(config)
  return async () => {
    request.signal.throwIfAborted()
    request.store.assertDispatch(request.lease)
    let snapshot: BotModelSnapshot
    try {
      snapshot = await readBotModelSnapshot(modelFile)
    } catch {
      request.signal.throwIfAborted()
      throw new BotDomainError(
        "model_configuration_unavailable",
        "模型配置正在同步或暂不可用，已停止发送请求，请检查设置后重试"
      )
    }
    request.signal.throwIfAborted()
    request.store.assertDispatch(request.lease)
    const ref = requestedRef ?? snapshot.defaultRef
    const current = snapshot.models.find((model) => model.ref === ref || model.id === ref)
    if (!current || identity(current) !== fingerprint) throw changed()
    try {
      request.store.pinRunModel(request.lease, fingerprint, {
        modelRef: config.ref,
        model: config.model
      })
    } catch (error) {
      if (error instanceof BotDomainError && error.code === "nonce_conflict") throw changed()
      throw error
    }
  }
}
