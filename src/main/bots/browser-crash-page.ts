import { teachSafeUrl } from "./teach-observation"

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character]!
  )

/** Host recovery notice, never a website success page or an automatic navigation. */
export function browserCrashRecoveryPage(previousUrl: string): string {
  const displayUrl = escapeHtml(teachSafeUrl(previousUrl).slice(0, 8192))
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>标签页已恢复 · 原操作结果待核对</title><style>
body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f8;color:#202124}
main{max-width:680px;margin:12vh auto;padding:40px;border:1px solid #e5e5e7;border-radius:24px;background:white}
h1{font-size:24px;line-height:1.4}p{font-size:16px;line-height:1.7}.url{overflow-wrap:anywhere;color:#666}
</style></head><body><main role="status" data-bot-recovery="tab-crash">
<h1>标签页已恢复，原操作结果仍需核对</h1>
<p>这是 CMBDevClaw 的本地恢复说明，不是原网站的成功结果。标签页发生崩溃，旧画面及操作目标已经失效。</p>
<p>没有重新执行点击、输入、提交或导航；崩溃前的操作可能已经生效，请先核对。当前控制权保持不变；Bot 必须重新观察后才能继续。</p>
<p>如需重新访问原网站，请明确输入网址导航。以下仅显示原网址，已隐藏常见凭据参数：</p>
<p class="url">${displayUrl || "原网址不可显示"}</p>
</main></body></html>`
}
