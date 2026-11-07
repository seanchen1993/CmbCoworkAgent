import type { WorkbenchDraft } from "./request"

export function demoDraft(projectRoot = ""): WorkbenchDraft {
  return {
    projectRoot,
    url: "http://127.0.0.1:4179/",
    document: "docs/api-correct.txt",
    focus: [
      "这是独立半成品 Vue 源码项目，请补齐真实接口接入和页面交互，然后启动、浏览器验证、修复复测。",
      "先阅读项目 README、AGENTS 和验收清单；保留后端、契约与验收测试，仅修改允许的前端源码。",
      "核对概览、订单列表与详情、筛选搜索和分页、仓库库存、趋势和通知；验证加载、空结果和错误状态。",
      "按项目现有检查命令和验收清单实际验证，不把打开页面或测试进程启动当成完成。"
    ].join("\n"),
    startCommand: "",
    checkCommand: ""
  }
}
