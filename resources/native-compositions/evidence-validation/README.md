# 来源与摘要衔接校验 Mod

这是独立、可复用的普通 Function Mod。平台不包含此业务规则。

## 明确检查范围

- `check-citations`：每个 `sourceId` 在真实上游来源文件存在，`quote` 是对应 `text` 的非空逐字子串。
- `check-report`：复核引用，并要求报告 `summary` 与真实上游摘要完全相同，`citations` 内容及顺序完全相同。
- 不判断来源是否可信、摘要是否由引用推出、因果是否成立。此类判断仍需要另加明确规则、人工复核或标明主观性质的评估。
- 产物中的 `passed:true`、模型说明和未执行的测试数据都不是通过证明。

## 数据契约

来源产物 `sources.json`：`{"sources":[{"id":"A","text":"服务在09:00至09:20不可用"}]}`。

摘要与报告产物均有 `summary:string` 和非空 `citations:[{sourceId:string,quote:string}]`。
例如 `{"summary":"已观察到服务中断，原因未确定。","citations":[{"sourceId":"A","quote":"09:00至09:20不可用"}]}`。
报告可增加其他展示字段；这两个约定字段必须原样衔接。没有来源时不可虚构引用以通过检查，应询问用户或停止该流程。

## 接入原项目门禁

1. 创造者先发现 `project_actions(query:"evidence-validation")`。未安装时发现 `catalog(catalogSection:"project-dependencies")` 中真实的 `sourceId:evidence-validation`，用 `dependency_prepare(sourceId:"evidence-validation")` 准备，结束本轮等待原生安装及权限确认。
2. 确认后重新读取真实动作目录，不自行填 pluginId、digest。项目 `composition/source.json` 中的动作检查通过 provider `{plugin:"evidence-validation",actionId:"check-citations"}` 或 `check-report` 引用实际提供方，由编译器锁定当前身份。
3. 检查使用 `kind:"action",format:"artifact-reference-v1",maxBytes:28000`。摘要阶段声明来源产物为 input；报告阶段同时声明来源和摘要为 inputs。`config:{sourceArtifactId:"sources"}`；报告另加 `summaryArtifactId:"summary"`，值必须匹配该项目真实 artifactId。
4. 本 Mod 读取 Host 提供的当前和已声明上游产物路径，只在项目目录内按原权限读取文件。它需要 `fs.read` 授权，不获得文件写入、网络、进程或状态提交权限。Host 对真实输入指纹、原始动作结算和阶段提交负责。
5. 编译与产物结构测试不会执行公开业务动作。必须实际试用项目，确认错误引用、报告改写摘要会阻止推进，修正后才能通过。上游文件改变后旧校验回执不能再次提交。

当前适配每文件最多64 KiB、最多8个参考文件。复杂阶段调试的准入限制保持原状，本 Mod 不宣称支持任意阶段恢复。
