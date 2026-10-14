import type { RegisterFunction } from "./sdk-types"
import {
  actionInput,
  boundedSource,
  readState,
  recordFingerprint,
  selectedRecord,
  sourceDescription
} from "./shared"

export function register(on: RegisterFunction): void {
  on("session.start", {}, async ($, event, next) => {
    await $.command.register({
      name: "autobiz-fullstack-prepare-review",
      description: "Autobiz：准备真实单文件检视输入",
      isHidden: true
    })
    return next(event)
  })
  on("command.run", { command: "autobiz-fullstack-prepare-review" }, async ($, event) => {
    const { feature, path } = actionInput(event.args)
    const before = selectedRecord(await readState($), feature)
    const source = boundedSource(await $.fs.read(path))
    const after = selectedRecord(await readState($), feature)
    if (recordFingerprint(before) !== recordFingerprint(after))
      throw Error("AUTOBIZ_FEATURE_CHANGED: 准备期间选定 Feature 的规范记录已改变，请重新执行。")
    return {
      text: `已准备 ${feature} 的真实单文件输入。尚未执行模型检视、项目测试或阶段推进。`,
      output: {
        feature,
        checkpoint: after.checkpoint,
        stage: after.stage,
        path,
        source,
        context:
          sourceDescription() +
          `\nFeature ${feature}；原规范记录阶段 ${after.stage}；checkpoint ${after.checkpoint}。` +
          "仅供单文件检视，不代表业务验收或测试证据。"
      }
    }
  })
}
