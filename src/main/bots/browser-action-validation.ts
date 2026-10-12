import { BotDomainError } from "../../shared/bot-types"
import * as v from "./validation"
import { validateBotFileName } from "./artifact-validation"

const operations = new Set([
  "navigate",
  "resize",
  "snapshot",
  "click",
  "mouse_click_xy",
  "type",
  "fill",
  "select_option",
  "press_key",
  "scroll",
  "tabs",
  "screenshot",
  "drag",
  "get_bounding_box",
  "highlight",
  "cdp"
])
const readOnlyCdp = new Set([
  "DOM.getDocument",
  "DOM.getOuterHTML",
  "Accessibility.getFullAXTree",
  "Page.getLayoutMetrics"
])

/** Pure validation shared by broker dispatch and model-tool admission. No target,
 * browser, approval, receipt or external action is created by this function. */
export function validateBotBrowserAction(input: unknown): Record<string, unknown> & { op: string } {
  const action = v.record(input),
    op = v.text(action.op, "浏览器操作", 40)
  if (!operations.has(op)) throw new BotDomainError("invalid_input", "不支持的浏览器操作")
  if (v.canonicalJson(action).length > 128_000)
    throw new BotDomainError("invalid_input", "浏览器参数过大")
  if (action.deliver !== undefined || action.name !== undefined) {
    if (op !== "screenshot")
      throw new BotDomainError("invalid_input", "只有 screenshot 支持交付截图附件")
    if (action.deliver !== undefined) v.boolean(action.deliver, "交付截图")
    if (action.name !== undefined) {
      const name = validateBotFileName(action.name)
      if (action.deliver !== true || !/\.jpe?g$/i.test(name))
        throw new BotDomainError(
          "invalid_input",
          "截图原件为 JPEG；请设置 deliver=true 并使用 .jpg 或 .jpeg 文件名"
        )
    }
  }
  if (op === "resize") {
    const width = v.integer(action.width, "页面宽度", 320, 2560)
    const height = v.integer(action.height, "页面高度", 240, 1600)
    if (width * height > 4_096_000)
      throw new BotDomainError("invalid_input", "页面尺寸不能超过 4096000 像素")
    if (Object.keys(action).some((key) => !["op", "width", "height"].includes(key)))
      throw new BotDomainError("invalid_input", "resize 仅支持 width 和 height")
  }
  if (op === "press_key") v.text(action.key, "按键", 100)
  if (op === "navigate") {
    const value = v.text(action.url, "网址", 8192)
    let url: URL
    try {
      url = new URL(value)
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      throw new BotDomainError("invalid_url", "网址必须是完整的 HTTP/HTTPS URL")
    }
    if (!["https:", "http:"].includes(url.protocol))
      throw new BotDomainError("invalid_url", "仅允许打开 HTTP/HTTPS 网页")
    if (url.username || url.password)
      throw new BotDomainError("invalid_url", "网址中不能携带登录凭据")
  }
  if (op === "cdp" && !readOnlyCdp.has(String(action.method))) {
    throw new BotDomainError("cdp_denied", "此 CDP 操作不在浏览器授权接口内")
  }
  return { ...action, op }
}

export function parseBotBrowserToolAction(op: unknown, argumentsJson: unknown) {
  const json = v.text(argumentsJson, "浏览器参数", 64_000)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new BotDomainError("invalid_input", "arguments_json 必须是有效的 JSON 对象")
  }
  return validateBotBrowserAction({ ...v.record(parsed), op })
}
