/**
 * 临时措施：内网模型网关对 deepseek / minimax 系列的采样参数处理有问题，
 * 因此这两个系列在真正发请求时不带 temperature / top_p / top_k。
 *
 * 只影响请求体，不改模型配置本身——设置界面里这三个值照常显示和保存，
 * 网关恢复后把开关关掉即可原样生效，不需要用户重新填。
 *
 * 关闭方式：`CMB_STRIP_SAMPLING_PARAMS=0`（也接受 false / off / no）。
 * 未设置或设为其他值时过滤生效。
 */

/** 与 registry.ts 的 modelPreset 一致，按 model 字符串识别系列。 */
const STRIPPED_MODEL_PATTERN = /deepseek|minimax/i

const DISABLED_VALUES = new Set(["0", "false", "off", "no"])

function stripEnabled(): boolean {
  const raw = process.env.CMB_STRIP_SAMPLING_PARAMS?.trim().toLowerCase()
  if (!raw) return true
  return !DISABLED_VALUES.has(raw)
}

/** 该模型的采样参数是否必须从请求体里摘掉。 */
export function shouldStripSamplingParams(model: string | undefined | null): boolean {
  if (!model) return false
  if (!stripEnabled()) return false
  return STRIPPED_MODEL_PATTERN.test(model)
}

/**
 * 展开进 ChatOpenAI 构造参数的 temperature / topP。
 *
 * 命中系列时返回空对象——LangChain 对缺省字段不会补默认值，这两项会
 * 完全不出现在请求 JSON 里，而不是退化成某个默认值。
 */
export function samplingFields(
  model: string | undefined | null,
  params: { temperature?: number; topP?: number }
): { temperature?: number; topP?: number } {
  if (shouldStripSamplingParams(model)) return {}
  return {
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.topP === undefined ? {} : { topP: params.topP })
  }
}

/**
 * 展开进 modelKwargs 的 top_k。top_k 不是 OpenAI 协议字段，各调用点本来
 * 就只在 topK > 0 时显式塞进 modelKwargs，这里保持同样的语义再叠加过滤。
 */
export function topKModelKwargs(
  model: string | undefined | null,
  topK: number | undefined | null
): { top_k?: number } {
  if (!topK || topK <= 0) return {}
  if (shouldStripSamplingParams(model)) return {}
  return { top_k: topK }
}
