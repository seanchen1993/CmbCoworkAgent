# 执行与证据提供器契约 v1

项目 workflow 消费 `devclaw.execution-evidence/v1`，不识别测试框架名称。组合作者将完整执行与证据 Mod 的实际安装身份锁定；能力之间不以模型填写的成功字段建立信任。

## 必需动作

- `test.contract`：按显式 executionAdapter 返回 protocol、executionAdapter、actions、compileInputSchema、inputSchema 和使用说明。compileInputSchema 返回对象必须包含 compileArgv。inputSchema 定义测试作者的 testInput。
- `prepare-test`：验证 testInput，返回 passed、executionAdapter 和有界 argv。准备动作不运行测试。
- `execute-command`：接收 phase（compile/test/e2e）、受控工作树、生产提交、基线提交、taskIds、workspaceRef 与 argv；执行实际命令并返回真实统计、测试/生产文件摘要、提交与性能检查结果。不能仅复制输入中的 passed。
- `inspect-workspace`：核验实际 HEAD 和干净状态。
- `repair-evidence`：读取当前运行的原始失败回执，核对任务、提交、测试资产及预算，不能接受其他运行的失败作为修复凭据。
- `code.verify` / `delivery.verify`：检查 Host 提供的真实产物，核验原 workflow 和动作回执。精确身份、资源摘要和角色绑定由编译器注入。

## 组合与兼容

编译器把 `nativeCompositionProvider`、`rulesProvider` 和 `workflowSha256` 固定到验收动作 config；规则关联动作必须来自同一已安装规则包。artifactRoles 按 artifactId 选择真实输入，角色不能改写 Host 路径或摘要。完整输入仍参与失效检查。

同一 Mod 内的编译器、测试器与证据校验可使用框架专用实现。替换整个提供器时须保持 workflow 消费的回执字段与步骤契约，并重新安装、编译、确认和试用。不兼容的结果协议需要显式迁移 workflow 与验收器，不能仅修改名称。

默认提供器实际支持 Node 内置 test runner，以及 Maven 编译 Java 后由 Python unittest 调用 Java 的路线。其他框架只有经过真实执行与 Host 验收后才算支持。

## 失败与修复

测试必须有实际用例、无失败或跳过，并绑定生产与测试字节。该条件证明运行事实，不证明全部业务已覆盖，业务效果还需外部固定验收样例及独立审查。

自动修复仅接受原始失败证据支持的一次 source_bug。test_bug 停止自动流程并保留失败记录，审查测试变更后创建新运行；原失败运行不改写为成功。合并、发布等副作用继续依赖原生确认和状态核对。
