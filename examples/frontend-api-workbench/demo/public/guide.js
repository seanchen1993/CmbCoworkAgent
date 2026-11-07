const base = window.location.origin
document.getElementById("target").value = base + "/orders"
document.getElementById("contract").value = base + "/api-docs"
for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const input = document.getElementById(button.dataset.copy)
    const status = document.getElementById("copy-status")
    try {
      await navigator.clipboard.writeText(input.value)
      status.textContent = "已复制。切回 DevClaw，粘贴到聊天顶部工作台。"
    } catch {
      input.focus()
      input.select()
      status.textContent = "内容已选中，请按 Ctrl+C 复制。"
    }
  })
}
