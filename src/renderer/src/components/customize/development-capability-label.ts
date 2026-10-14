/** Friendly copy never changes the capability identifiers submitted for approval. */
const labels: Record<string, string> = {
  "event:ui.render": "在聊天界面显示内容",
  "event:tool.call": "处理工具调用事件",
  "event:command.run": "处理命令运行事件",
  "event:session.start": "处理会话开始事件",
  "event:turn.complete": "处理每轮完成事件",
  "ui.open": "打开界面面板",
  "ui.close": "关闭界面面板",
  "ui.panes": "查看可用面板",
  "ui.resolve": "构建界面组件",
  "ui.invalidate": "刷新组件显示",
  "ui.log": "显示组件日志",
  "ui.status": "显示状态信息",
  "ui.toast": "显示提示消息",
  "store.get": "读取组件隔离存储",
  "store.set": "写入组件隔离存储",
  "store.keys": "列出组件存储项目",
  "store.delete": "删除组件存储项目",
  "session.usage": "读取本会话用量",
  "session.version": "读取会话版本信息",
  "clock.time": "读取当前时间",
  "clock.now": "读取当前时间戳",
  "command.register": "注册组件命令",
  "command.list": "查看可用命令"
}
export function developmentCapabilityLabel(capability: string): string {
  return labels[capability] ?? capability
}
