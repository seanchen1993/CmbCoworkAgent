export default {
  register(on) {
    on.ui({ id: "output-summary", slot: "tool.result.after" }, async (event) => {
      if (!event.model.outputProtected) return []
      const count = (event.model.text.match(/\[REDACTED\]/g) || []).length
      return [
        {
          type: "card",
          title: "输出保护",
          children: [
            {
              type: "text",
              text:
                count > 0
                  ? `本次可见文本包含 ${count} 处脱敏标记。`
                  : "已应用宿主输出规则；当前可见文本没有脱敏标记。"
            }
          ]
        }
      ]
    })
  }
}
