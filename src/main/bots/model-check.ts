import { createHash, randomInt, randomUUID } from "node:crypto"
import { HumanMessage, type AIMessage } from "@langchain/core/messages"
import { createConfiguredCmbModel } from "../models/model-factory"
import { modelConnectionHint } from "../models/connection-diagnostics"
import { getStatusInfo } from "../agent/api-errors"
import { readModelRefusal } from "../agent/model-refusal"
import { isTruncationFinishSignal, readFinishSignal } from "../agent/turn-completion-integrity"
import { BotDomainError } from "../../shared/bot-types"
import {
  botModelCheckAddress,
  botModelCheckInput,
  type BotModelCheckInput,
  type BotModelCheckResult
} from "../../shared/bot-model-check"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { canonicalJson } from "./validation"
import { botModelCheckImages } from "./model-check-images"
import { BotModelAnswerProjection } from "./model-answer-projection"

type Config = BotModelSnapshot["models"][number]
type Entry = {
  input: string
  configuration?: string
  client: AbortSignal
  controller: AbortController
  expiresAt: number
  active: boolean
  promise: Promise<BotModelCheckResult>
}
const identity = (config: Config) =>
  createHash("sha256").update(canonicalJson(config)).digest("hex")

/** Exact sample bytes or legal tool arguments do not override an explicit
 * provider refusal or truncation. Read protocol facts, never infer them from prose. */
function completionFailure(answer: AIMessage): string | undefined {
  if (readModelRefusal(answer)) return "模型服务拒绝了本次检查，未通过；请按需重试。"
  if (isTruncationFinishSignal(readFinishSignal(answer)))
    return "模型回复被长度上限截断，未通过；请按需重试。"
  return undefined
}

/** User-triggered diagnostics, isolated from task history and tool execution.
 * A pass verifies this basic sample only; it is never a permission or quality score. */
export class BotModelChecks {
  private readonly entries = new Map<string, Entry>()
  private readonly configurations = new Map<string, string>()
  private readonly shutdown = new AbortController()
  constructor(private readonly modelFile: string) {}

  private async resolve(ref: string | null, signal: AbortSignal): Promise<Config> {
    signal.throwIfAborted()
    const snapshot = await new Promise<BotModelSnapshot>((resolve, reject) => {
      const abort = () =>
        reject(new BotDomainError("model_check_cancelled", "模型检查已取消或超时"))
      signal.addEventListener("abort", abort, { once: true })
      void readBotModelSnapshot(this.modelFile)
        .then(resolve, () =>
          reject(new BotDomainError("model_configuration", "无法读取模型配置，请检查应用设置"))
        )
        .finally(() => signal.removeEventListener("abort", abort))
    })
    signal.throwIfAborted()
    const selected = ref ?? snapshot.defaultRef
    const config = snapshot.models.find((value) => value.ref === selected || value.id === selected)
    if (!config?.apiKey)
      throw new BotDomainError("model_missing", "请先在应用设置中配置模型和 API 密钥")
    const url = URL.parse(config.baseUrl)
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new BotDomainError("model_url", "模型接口地址无效，请检查应用设置")
    return config
  }

  async check(raw: unknown, client: AbortSignal): Promise<BotModelCheckResult> {
    const input = botModelCheckInput.parse(raw)
    client.throwIfAborted()
    this.shutdown.signal.throwIfAborted()
    for (const [key, entry] of this.entries)
      if (!entry.active && entry.expiresAt < Date.now()) this.entries.delete(key)
    const previous = this.entries.get(input.nonce),
      serialized = canonicalJson(input)
    if (previous) {
      if (previous.input !== serialized)
        throw new BotDomainError("model_check_changed", "模型或检查内容已变化，请重新检查")
      if (!previous.active && previous.configuration) {
        const signal = AbortSignal.any([client, this.shutdown.signal, AbortSignal.timeout(20_000)])
        if (identity(await this.resolve(input.modelRef, signal)) !== previous.configuration)
          throw new BotDomainError("model_check_changed", "模型配置已变化，请重新检查")
      }
      return previous.promise
    }
    if ([...this.entries.values()].filter((entry) => entry.active).length >= 2)
      throw new BotDomainError("model_check_busy", "已有模型检查进行中，请稍后再试")
    if (this.entries.size >= 100) {
      const oldest = [...this.entries].find(([, entry]) => !entry.active)
      if (oldest) this.entries.delete(oldest[0])
    }
    const controller = new AbortController()
    const signal = AbortSignal.any([
      client,
      this.shutdown.signal,
      controller.signal,
      AbortSignal.timeout(20_000)
    ])
    const promise = Promise.resolve()
      .then(async () => {
        const config = await this.resolve(input.modelRef, signal),
          configuration = identity(config)
        entry.configuration = configuration
        if (!this.configurations.has(configuration)) {
          if (this.configurations.size >= 100)
            this.configurations.delete(this.configurations.keys().next().value!)
          // The renderer gets an opaque identity, never a digest of credential fields.
          this.configurations.set(configuration, randomUUID())
        }
        return this.probe(input, config, signal, this.configurations.get(configuration)!)
      })
      .finally(() => {
        entry.active = false
      })
    const entry: Entry = {
      input: serialized,
      client,
      controller,
      active: true,
      expiresAt: Date.now() + 10 * 60_000,
      promise
    }
    this.entries.set(input.nonce, entry)
    return entry.promise
  }

  cancel(raw: unknown, client: AbortSignal): void {
    const { nonce } = botModelCheckAddress.parse(raw),
      entry = this.entries.get(nonce)
    if (!entry?.active) return
    if (entry.client !== client)
      throw new BotDomainError("model_check_owner", "此检查属于另一个客户端")
    entry.controller.abort(new Error("检查已取消"))
  }

  async close(): Promise<void> {
    this.shutdown.abort(new Error("后台正在停止"))
    await Promise.allSettled([...this.entries.values()].map((entry) => entry.promise))
    this.entries.clear()
    this.configurations.clear()
  }

  private async probe(
    input: BotModelCheckInput,
    config: Config,
    signal: AbortSignal,
    configuration: string
  ): Promise<BotModelCheckResult> {
    const start = Date.now()
    let httpStatus: number | undefined
    let transportError: unknown
    const result = (passed: boolean, detail: string): BotModelCheckResult => ({
      kind: input.kind,
      status: passed ? "passed" : "failed",
      detail,
      modelRef: config.ref,
      modelName: config.name,
      model: config.model,
      configuration,
      checkedAt: Date.now(),
      latencyMs: Date.now() - start
    })
    try {
      const model = createConfiguredCmbModel(
        { ...config, maxOutputTokens: 512 },
        {
          purpose: "function-completion",
          preserveProviderRefusal: true,
          fetch: async (url, init) => {
            signal.throwIfAborted()
            const response = await fetch(url, {
              ...init,
              redirect: "error",
              signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
            }).catch((error: unknown) => {
              transportError = error
              throw error
            })
            httpStatus = response.status
            // Even an error body may echo credentials; none is returned to the UI.
            const body = response.body?.getReader(),
              chunks: Uint8Array[] = []
            let size = 0
            try {
              while (body) {
                const { done, value } = await body.read().catch((error: unknown) => {
                  transportError = error
                  throw error
                })
                if (done) break
                size += value.length
                if (size > 128 * 1024) throw new Error("model_check_response_limit")
                chunks.push(value)
              }
            } finally {
              await body?.cancel().catch(() => {})
            }
            signal.throwIfAborted()
            return new Response(Buffer.concat(chunks), {
              status: response.status,
              headers: response.headers
            })
          }
        }
      )
      const marker = randomUUID()
      let passed = false
      let failureDetail: string | undefined
      if (input.kind === "tools") {
        const answer = await model
          .bindTools([
            {
              type: "function",
              function: {
                name: "cmb_capability_check",
                description: "Return the provided marker; this function is never executed.",
                parameters: {
                  type: "object",
                  properties: { marker: { type: "string" } },
                  required: ["marker"],
                  additionalProperties: false
                }
              }
            }
          ])
          .invoke(
            [new HumanMessage(`Call cmb_capability_check exactly once with marker ${marker}.`)],
            { signal }
          )
        failureDetail = completionFailure(answer)
        const call = answer.tool_calls?.[0]
        passed =
          !failureDetail &&
          answer.tool_calls?.length === 1 &&
          call?.name === "cmb_capability_check" &&
          canonicalJson(call.args) === canonicalJson({ marker })
      } else {
        const colors = Object.keys(botModelCheckImages) as (keyof typeof botModelCheckImages)[]
        // Multiple independent colors make accidental text-only guessing unlikely.
        const samples = Array.from({ length: 6 }, () => colors[randomInt(colors.length)])
        const expected = input.kind === "text" ? marker : samples.join(",")
        const answer = await model.invoke(
          [
            new HumanMessage({
              content:
                input.kind === "text"
                  ? `Return exactly this marker, with no other text: ${marker}`
                  : [
                      {
                        type: "text",
                        text: "Identify the solid color of each of the six images, in order. Reply with exactly six lowercase color names separated by commas, no spaces. Each name must be red, blue, green or yellow."
                      },
                      ...samples.map((color) => ({
                        type: "image_url" as const,
                        image_url: { url: `data:image/png;base64,${botModelCheckImages[color]}` }
                      }))
                    ]
            })
          ],
          { signal }
        )
        failureDetail = completionFailure(answer)
        if (!failureDetail) {
          const projection = new BotModelAnswerProjection()
          projection.pushMessage(answer)
          passed = projection.finish().trim() === expected && !answer.tool_calls?.length
        }
      }
      signal.throwIfAborted()
      if (identity(await this.resolve(input.modelRef, signal)) !== identity(config))
        throw new BotDomainError("model_check_changed", "检查期间模型配置已变化，请重新检查")
      return result(
        passed,
        passed
          ? input.kind === "tools"
            ? "收到参数正确的工具调用，检查工具未执行。"
            : input.kind === "vision"
              ? "六张测试图片的颜色与顺序均正确。"
              : "文字请求与响应正常。"
          : (failureDetail ?? "接口有响应，但未返回预期结果；请检查模型能力和服务配置。")
      )
    } catch (error) {
      if (error instanceof BotDomainError && error.code.startsWith("model_answer_"))
        return result(false, "接口有响应，但模型正文未完整生成或超出检查上限；请按需重试。")
      if (error instanceof BotDomainError) throw error
      const status = getStatusInfo(httpStatus)
      return result(
        false,
        signal.aborted
          ? "检查已取消或超过 20 秒，请按需重试。"
          : httpStatus && httpStatus >= 400
            ? status
              ? `模型服务返回 HTTP ${httpStatus}（${status.label}）${status.hint ? `，${status.hint}` : ""}。`
              : `模型服务返回 HTTP ${httpStatus}，请检查服务状态及接口配置。`
            : (modelConnectionHint(transportError) ??
              "未完成检查，请检查模型接口、网络及服务配置。")
      )
    }
  }
}
