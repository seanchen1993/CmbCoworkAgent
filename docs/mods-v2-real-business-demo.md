# 真实模型与 Autobiz 业务演示

2026-09-24，订单 CSV 导出示例已在真实 Electron 应用跑通：关闭项目规则时错误实现直接结束；开启「自动修复并复检」后，真实评审和原生测试发现缺陷，原 Agent 修复，重新检查通过后由宿主推进 checkpoint。项目外的七条业务断言通过，需求、测试和脚本未被修改。

详情见 [验证报告](../output/mods-v2-validation/2026-09-24-real-business-demo.md)。该报告区分模型意见、原生测试、真实 upstream validator、独立业务断言与状态提交，不将它们混为一个 PASS。

## 重现

先按项目 Node 策略准备依赖并运行普通 `npm run build`。需本机可用的真实自定义模型、固定 Autobiz 源仓库及 Python（路径和固定提交见[项目规则说明](mods-v2-application-completion-rules.md)）。不需要本地安装包或 NSIS。

PowerShell：

```powershell
$env:CMB_MODS_REAL_MODEL_DEMO = "1"
$env:CMB_MODS_DEMO_MODEL_ID = "claude"
$env:CMB_MODS_DEMO_ARTIFACTS = "output/mods-v2-validation/my-real-business-demo"
node node_modules/tsx/dist/cli.mjs tests/mods-business-demo.spec.ts
```

模型 ID 对应当前应用已有的 custom-models.json 配置。脚本只读指定模型及对应凭据，不调用配置迁移；密钥仅用于内存中的真实请求转发，不写入隔离应用或报告。脚本使用新的临时项目和独立应用数据，不修改现有任务或 UAT 工作树。这是明确启用的真实请求演示，不属于普通离线测试。

示例配置项目范围、代码评审、单元测试和 Autobiz validator；原完成循环最多修复两次，最长十分钟，模型输入与输出总预算 350000 tokens。成功演示实际预算证据为 110945 tokens；较低预算的历史运行正确中止。总预算包括修复时反复发送的上下文及在途预留，不能按最终答案字数估算。

产物包含 off/on 截图、完整宿主证据、模型请求数量、独立断言结果和保护文件指纹。脚本在原界面逐次确认限定文件操作，不开启永久免审批。它先要求模型尝试完成，再观察是否由门禁触发修复，因此是受控的错误完成对照；不代表所有业务任务的成功率。

## 使用范围

应用能力仍以[项目规则说明](mods-v2-application-completion-rules.md)和[兼容矩阵](mods-v2-compatibility-matrix.json)为准。旧单文件评审命令可作为辅助意见；最终推进取决于所选真实检查和绑定证据。不要同时启用重复执行同一 validator 的 classic hooks 和项目完成规则。业务示例通过不表示剩余性能、长稳、兼容差异与 GitHub Actions 安装包门禁已通过。
