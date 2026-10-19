import type { Register } from "claude-code"

export const register: Register = (on) => {
  on("prompt.section", { name: "creator.planning" }, async () => ({
    text: "先明确用户希望观察的效果与验收方法，再检索已有 Mod 和插件。优先组合已验证能力；仅为缺失部分创建最小实现。修改展示时复用已有结果，避免重跑无关业务。提交后核对宿主返回的真实状态，保留失败诊断和当前可用版本。"
  }))
}
