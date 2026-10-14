export function register(on) {
  let status = "先选中一段聊天文字，再点击下方按钮。"
  on("session.start", async ($, event, next) => {
    await $.command.register({ name: "selection-board", description: "打开所选文字组件", immediate: true })
    return next(event)
  })
  on("command.run", { command: "selection-board" }, async ($) => {
    await $.ui.open({ id: "selection-board", title: "所选文字", rows: 8 })
    return { text: "请打开右侧 Claw 工作台的“插件与结果”，选中聊天文字后点复制。" }
  })
  on("ui.render", { component: "Pane", requestId: "selection-board" }, ($, event) => {
    const { Box, Text, Button } = $.ui.resolve(event)
    return <Box flexDirection="column" gap={1}>
      <Text>{status}</Text>
      <Button key="copy-selection" label="复制所选文字" onPress={async () => {
        const selection = await $.ui.selection()
        if (!selection?.text) status = "还没有选择内容。请先选中当前聊天里的文字。"
        else {
          const result = await $.ui.copy({ text: selection.text })
          status = result.isCopied ? "已复制。现在可以粘贴查看其他组件处理后的内容。" :
            result.reason === "no-clipboard" ? "剪贴板当前不可用，请稍后再试。" :
            result.reason === "no-surface" ? "当前聊天界面不可用，请重新打开聊天。" : "这次复制被组件规则拒绝。"
        }
        $.ui.invalidate("ui.render")
      }} />
    </Box>
  })
}
