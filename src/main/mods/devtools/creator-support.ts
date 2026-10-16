import { CREATOR_REQUEST_LIMITS } from "./creator-request-budget"

/** A bounded first-release promise, not an authorization envelope or a replacement SDK. */
export const CREATOR_S1_SUPPORT = Object.freeze({
  id: "creator-s1-2026-10-16",
  target: "当前已关联本地项目的普通聊天",
  sites: ["AbovePrompt", "PromptHint", "InfoNotice", "TurnDuration"],
  events: [
    "session.start",
    "ui.render",
    "tool.call",
    "command.run",
    "turn.complete",
    "prompt.compose"
  ],
  localMethods: [
    "ui.open",
    "ui.close",
    "ui.resolve",
    "ui.invalidate",
    "ui.log",
    "ui.status",
    "ui.toast",
    "store.get",
    "store.set",
    "store.keys",
    "store.delete",
    "command.register",
    "clock.now"
  ],
  authorizedMethods: [
    "http.fetch",
    "fs.read",
    "fs.list",
    "fs.exists",
    "fs.stat",
    "model.complete",
    "tool.call",
    "tool.list",
    "tool.check"
  ],
  configuration: [
    "按已有 schema 修改组件字段",
    "对象深合并、数组替换、显式字段删除",
    "真实模型/技能/MCP 选择",
    "目录/文件绑定与敏感字段沿用原校验；不读取或导出敏感值"
  ],
  reuse: ["命名组合保存/套用", "当前草稿恢复后重新核对", "原安装事务确认后的正式函数 Mod 复用"],
  limits: CREATOR_REQUEST_LIMITS,
  unsupported: [
    "任意 DOM/CSS 或宿主/权限内核重写",
    "动态/通配事件",
    "自动启动任意已保存 Flow",
    "完整业务插件导出或中间阶段重跑",
    "跨项目复用旧授权",
    "未知副作用自动重放"
  ],
  onUnsupported:
    "保留当前运行版、草稿和可用组合，说明具体缺口及实际支持的替代方案；未应用的部分标为草稿。不要删除原功能、关闭其它 Mod 或虚构能力来宣称完成。高级 SDK 的存在不等于首批自动创作保证。"
})
