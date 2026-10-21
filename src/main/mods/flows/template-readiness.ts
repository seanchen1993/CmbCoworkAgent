import { planProjectCheck } from "../v2/project-check-plan"

/** Read-only use of the same planner used by real execution; never runs or installs a test. */
export async function readFlowUnitTestReadiness(workspace: string) {
  try {
    const plan = await planProjectCheck(workspace, "unit-test")
    return { ready: true, command: plan.command }
  } catch {
    return {
      ready: false,
      reason:
        "未找到可用的项目测试入口，或配置无法安全读取。请在项目 package.json 声明 test:unit / test，或在 .cmb/project-checks.json 配置已有 Python unittest 目录；修正后刷新。不会自动安装依赖或生成测试。"
    }
  }
}
