/**
 * 「模型正在重试」横幅的消失判据。
 *
 * 两种重试共用这个横幅，但拿到「重试已经过去了」这个信号的方式不一样：
 *
 *   传输层重试（retryStreamAfterDisconnect）：流已经死了，等 500/1500ms 再
 *     resume()。resume 一成功主进程就显式发 model_retry_clear，横幅在新回答开始
 *     streaming 之前就消失。
 *   完成门禁续跑（turn-completion-integrity）：不等待，判定完立刻 jumpTo 模型。
 *     主进程这边没有「重试成功」这个时刻可发——门禁下一次拿到消息已经是整段
 *     重答结束之后了，那时候再清，横幅会在一段正常流动的回答旁边空转几十秒。
 *
 * 所以门禁这条用的判据是「模型又开始产出可见内容了」：举横幅时记下当前 live
 * 助手内容的总量当水位，之后只要总量涨过水位就清掉。等价于 processSchedulerEvent
 * 里 message-delta 那条 defensive clear，只是主前台流没有逐 token 的钩子，只能
 * 在每次 stream 更新时比水位。
 *
 * 水位在举横幅的那一刻取，所以传输层那条不会被断流前的存量内容误清——它本来也
 * 有 model_retry_clear 先一步兜底，这里只是多一层。
 */

import { liveStreamMessageRole, type LiveStreamMessage } from "./live-stream-messages"

function contentLength(content: LiveStreamMessage["content"]): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (typeof block === "string") {
      total += block.length
      continue
    }
    if (!block || typeof block !== "object") continue
    const text = (block as { text?: unknown }).text
    if (typeof text === "string") total += text.length
  }
  return total
}

/**
 * 当前 live 流里助手已产出的可见字符总量。
 *
 * 只数正文，不数 reasoning：一次只吐思考内容的重答仍然是没有结果，横幅不该因此
 * 消失（门禁自己也把 thinking-only 判成 reasoning_only 缺陷）。
 */
export function liveAssistantContentWatermark(
  messages: readonly LiveStreamMessage[] | undefined
): number {
  if (!messages?.length) return 0
  let total = 0
  for (const message of messages) {
    // 角色判定沿用 liveStreamMessageRole：它是排除法（非 human/tool/system 即
    // assistant），自己另写一份白名单会在新 type 出现时静默漏算。
    if (liveStreamMessageRole(message.type) !== "assistant") continue
    total += contentLength(message.content)
  }
  return total
}

/** 模型是否已经在水位之上产出了新的可见内容。 */
export function hasModelRetryProgress(
  watermark: number,
  messages: readonly LiveStreamMessage[] | undefined
): boolean {
  return liveAssistantContentWatermark(messages) > watermark
}
