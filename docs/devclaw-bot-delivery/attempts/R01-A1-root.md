# R01-A1 / root 串行报告

2026-10-11。基线31a795c1，集成树codex/devclaw-bot-integration；旧local树不动。任务v1及入口决定已保存，state/HANDOFF记录此次手动授权，定时PAUSED。

起点核对：只有root，两个树clean，无相关Java/Maven/任务进程；原MySQL/ES/S3 same名称healthy/127端口，未创建资源或读其秘密。Node22.22.2路径为/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node，现有tsx/typescript可用，无安装。

首轮：新增纯模块和13条Node22/tsx测试，全部通过；主进程tsc（43386）实际exit0，F03冻结检查（71250）实际exit0、24/24/生成漂移与类型消费通过。单独测试文件tsc报告workspace.read不是冻结Capability，测试fixture已改为空能力集合。该检查先前和Git状态命令同shell导致末尾返回0，不能把它当类型通过；下一单独重跑真实tsc。未调用模型、Run、群消息或真实平台。

待完成：格式整理后重跑新测试/测试类型，IM桥接与实际diff审查。无活动命令或资源变更，后续Run接入不在本小切片内。

最终离线复验（Node22.22.2，全部exit0/closed）：

- `--import tsx --test tests/bot/partner-prompt.spec.ts`：fa50a5，13/13，无skip。最终fixture capabilityCeiling为空合法集合；前述workspace.read类型失败保留为历史。
- `node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module commonjs --esModuleInterop tests/bot/partner-prompt.spec.ts`：0311c8独立命令exit0，不再被Git命令掩盖。
- `node_modules/typescript/bin/tsc --noEmit --composite false -p tsconfig.node.json`：43386/8cc07b，exit0；初始源码与格式整理后语义相同，新模块最终由上述严格编译再次覆盖。
- `tests/bot/check-contracts.mjs`：71250/87e5b1，24/24、生成漂移与类型消费通过。冻结Schema、生成契约类型未改。
- `--import tsx tests/im-desktop-run-bridge.spec.ts`：c43d0c，16项PASS。旧IM/执行引擎/模式入口源文件未改。
- `git diff --check`：无空白错误。只新增纯模块、测试及本轮决定/任务记录；无模型、网络、Node/Run或数据库入口调用，无依赖变更、无子代理或容器变更。

已检查实际实现：同空间/Task-Group/专家关联与固定BotVersion校验；系统提示与任务JSON分离；App/群均排除私人、错namespace、推断记忆；关闭策略全排除；只读快照与预算明确拒绝。JSON转义仅框架，不声称免疫提示词注入。真正Runtime尚未接入，尤其需禁止旧准备层自动注入个人memory，继续使用实际工具授权，不复用个人IM grant。

下一：等待用户对@/任务编号和开发负责人本地节点建议的反馈，再冻结Run/节点最小服务端与Desktop适配切片；不把这13条纯模块测试视为Runtime或招乎端到端验收。定时仍PAUSED。
