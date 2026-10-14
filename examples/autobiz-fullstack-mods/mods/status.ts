import type { RegisterFunction } from "./sdk-types"
import {
  commandFeature,
  readState,
  recordSummary,
  selectedRecord,
  sourceDescription
} from "./shared"

export function register(on: RegisterFunction): void {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "autobiz-fullstack-info",
      description: "查看 fullstack 0920 来源和只读增强范围",
      immediate: true
    })
    await $.command.register({
      name: "autobiz-fullstack-status",
      description: "经原分支只读入口查询项目规范状态",
      argumentHint: "[明确的 Feature ID]"
    })
    return next(event)
  })
  on("command.run", { command: "autobiz-fullstack-info" }, () => ({
    text:
      sourceDescription() +
      "\n此增强只读取状态、显示选定节点、准备单文件检视输入。不运行新分支 validator，" +
      "不推进 checkpoint，不证明项目测试通过。原 Plugin 业务与经典 Hook 保留，" +
      "普通本地演示不等于原 Biz/Dev/Ops 完整门禁验收。"
  }))
  on("command.run", { command: "autobiz-fullstack-status" }, async ($, event) => {
    const feature = commandFeature(event.args)
    const snapshot = await readState($)
    const rows = feature
      ? [selectedRecord(snapshot, feature)]
      : Object.keys(snapshot.records)
          .sort()
          .map((id) => snapshot.records[id])
    return {
      text:
        sourceDescription() +
        "\n原 state.json 规范化读取结果（未运行验证、未推进阶段）：\n" +
        (rows.length ? rows.map(recordSummary).join("\n\n") : "当前项目没有规范 Feature 记录。")
    }
  })
}
