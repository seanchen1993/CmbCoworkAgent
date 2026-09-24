# Pane 初始焦点生命周期验证 — 2026-09-24

功能基线2ce87e81，生产仅FunctionPanes.tsx新增8行；宿主revision仍v65，没有新增SDK权限或变更宿主协议。

## 失败与修复

先新增实际FunctionPanes/React组件回归，在普通Electron临时同源iframe中运行。仅包装组件的useRef以观察Set留存，不改变返回值；Box-only夹具不渲染Code/Svg/Client，三叶子导入隔离无关worker/store。宿主paneAct/panes回执是受控适配器，不冒充真实guest或业务验收。

第一轮red因iframe尚未attach而失败，只修fixture等待；red2在生产未修改时明确失败：关闭第一个面板后仍保留focus-request-0。之后最小修复按当前面板请求集修剪attemptedFocus、组件清理时清空，并在本线程快照未加载时跳过初始焦点处理。当前请求即使pending=false仍保留，防止旧pending快照重放。

首轮green的32次开关/去重、线程属性切换通过。随后补充已完成请求遇到旧pending快照不重放和卸载清理，最终结果待后续完整回归。主应用ChatContainer已经使用threadId作为组件key，线程属性测试是组件防御性边界，不称实际跨线程漏洞。未改变宿主focusAck、用户归属/epoch、权限、lease或generation，不称旧6408 ACK超时根因已修复。

## 验证

- 真实guest/session及renderer辅助函数窄测7文件78项通过，含18 Client生命周期、15 Client焦点、18 ui.focus、12 Pane焦点、9 Pane session及6 renderer辅助测试。
- Node/Web/helper types通过；3文件修改行ESLint通过，FunctionPanes及新helper无warning，根E2E保留80条旧warning且修改行无诊断。
- 普通新构建通过，最终Pane生命周期3、原生imperative-focus9、Client-focus9检查通过，覆盖取消/撤权/重载/off与原生composer。新增settled去重及unmount断言已在最终普通构建专项通过。全仓Vitest已完成：606文件中597通过/9失败，4732测试通过/26失败/5跳过。26个失败与此前旧0273980c已复现清单逐项名称一致，新增失败项0；原始日志、JSON及core-final-vitest-comparison.json保留，不能称全仓全绿。84条独立命令80通过、4失败；失败命令和实际断言均与旧基线一致，零中断/超时。workflow-worktree66场景通过。最终兼容表2文件21项及真实utilityProcess46项通过；完整Electron实际236检查全部通过并exit0，ordinary恢复且无测试bridge；dated回执为pane-lifecycle-final-full-electron-result.json。最终正式桌面性能已完成，结果见下，不属于全部门禁通过。

日志均位于output/mods-v2-validation/2026-09-24-pane-focus-lifecycle-*；中间fixture失败保留，不当作生产行为复现。用户允许延期复杂兼容边界，本修复只维护已有主要功能。

## 正式桌面性能及交付边界

87595退出1/DESKTOP_PERFORMANCE_BUDGET_FAILED，冻结目录desktop-performance-2026-09-24T15-15-19-538Z-full-7ae669bf。qualified=true、passed=false，110次实际请求，关闭/开启各50个流式样本、各300秒idle窗口；没有并行本机重测试或生产修改。

- TTFT p95：156.6→211.2ms，增量54.6ms，超过40ms门槛；p50为140.8→197.2ms。
- 吞吐比0.9974499119，高于0.95；空闲CPU从1.9061868458到2.0278363310，差+0.1216494852百分点，低于0.5。
- 原始run/exit/progress/result和日志保留。旧v63通过、先前失败及中断结果都不能替代本轮失败；没有证明54.6ms由此次8行清理单独引起，也不归因于已证实的机器噪声。

按用户核心优先和后续优化的最新要求，本次功能修复单独提交并继续Actions包内验证；TTFT优化列为后续未完成项，不修改门槛或重复测试以筛选通过结果。正式ingress和两小时长稳另行验证，包内运行也不等同NSIS安装/卸载验收。
