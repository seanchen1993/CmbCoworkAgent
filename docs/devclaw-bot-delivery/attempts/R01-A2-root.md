# R01-A2 / root 串行报告

2026-10-11，集成87a7b307 clean起点，实际仅root活动，无任务Java/Maven/tsx测试进程；自动配置读回PAUSED。最新两项人类选择已记录。旧local树与开发容器不变，不读秘密或创建资源。

实现准备：现有Runtime无条件getUserInfo并追加员工身份；memoryEnabled:false能关闭记忆工具/源，但invoke结束维护另看Thread metadata，四处子Runtime也需继承共享标志。仅加显式收窄开关，不重写引擎。任务解析沿用Java nextNumber生成的TASK-数字，@依赖可信结构化判定，不以文字包含机器人名称为授权。

首轮源码及新测试已保存（未提交）：group-task-intent/personal-context两模块，Runtime/标准工厂/invoke维护窄接线，两个新spec。a7926d实际30/30（新17+原13）exit0；architecture a0678a、旧IM桥接8f0d73/16项均exit0。未调用模型、数据库或平台。tsc测试99216、主进程34199、冻结契约53654正在执行，结果未确认；尚未验收。

最终：代码7bbb77e6，8个产品/测试文件，339新增/12删除；只改显式开关接线、解析和测试，不改旧IM源文件、模式、对外契约、Java服务、Docker、依赖或旧package测试命令。无子代理、推送、部署或真实平台。

Node22.22.2使用既有路径 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`，检查均已闭合/exit0：

- `--import tsx --test tests/bot/group-task-intent.spec.ts tests/bot/personal-context.spec.ts tests/bot/partner-prompt.spec.ts`：a7926d，30/30，新17+原13，无skip。
- `PATH=<Node22 bin>:$PATH npm run test:bot-partner`：168917，真实脚本30/30。只新增这一脚本，abeeab用deepEqual确认package其余字段/依赖/旧脚本与HEAD相同。
- `node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module commonjs --esModuleInterop tests/bot/group-task-intent.spec.ts tests/bot/personal-context.spec.ts tests/bot/partner-prompt.spec.ts`：99216/f8899a，exit0。
- `node_modules/typescript/bin/tsc --noEmit --composite false -p tsconfig.node.json`：34199/26e600，exit0。之后唯一源码变化是IPC新增行缩进整理，无语义改动；package只增测试脚本。
- `tests/bot/check-contracts.mjs`：53654/beeb54，24/24、冻结生成漂移与类型消费通过。
- `--import tsx tests/im-desktop-run-bridge.spec.ts`：8f0d73，16PASS；`tests/im-remote-runner.spec.ts`：14826/19b35c，11PASS。测试使用既有模拟实现，不是连接真实招乎。
- `--import tsx tests/standard-thread-turn-architecture.spec.ts`：a0678a；`tests/desktop-agent-runtime-entrypoints.spec.ts`：c511ef；`tests/desktop-agent-invoke-characterization.spec.ts`：0e60e1，10PASS。
- `--import tsx tests/runtime-final-system-prompt.spec.ts`：6741/eacc48，exit0，既有模拟模型/最终提示词回归。这不是createAgentRuntime共享条件的端到端执行证明。
- 新两模块/两spec及package `prettier --check`：e337a0，exit0。初次7文件format check曾警告runtime.ts/IPC，两者基线HEAD已不满足整文件formatter（80d953实际比较）；保留无关旧格式，仅修本次新增缩进。不称全项目格式通过，ff0ff9的shell末尾status为0也不抹掉格式警告。
- `git diff --check`：b7ed03 exit0。e29799逐对象校验所有既有accepted tasks完全不变；abeeab冻结/Java/Docker目录无diff。

实际diff检查：可信mention与显式开头命令才产出意图，没有任务查找/写入或最近任务默认关联；编号沿用真实Java的TASK-数字和安全整数上限。sharedTaskContext仅在可信RemoteTurnPolicy设置时收窄，工厂后应用；Runtime始终覆盖个人memory enabled、懒读身份不执行，四个子创建点继承（worker Harness spread之后），invoke本次个人记忆维护亦关闭。原路径默认false及原身份格式保持。没有增加授权、自动选节点或执行工具。

accepted仅此准备切片。尚缺：Run/节点最小控制与开发负责人显式授权、离线等待、专用Task/节点Thread、实际DesktopRuntimeProvider、群绑定/回调/可信mention归一化/收发、实际工具/撤权与技能Hook/历史/源码共享边界。未来不能复用旧个人Thread或仅靠提示词/这个开关宣称全面隔离。无活动测试句柄，定时继续PAUSED。
