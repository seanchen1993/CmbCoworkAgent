# 插件存在性发现：缩短热路径，保留执行链

八处只需要“存在至少一个 Function source”的入口改用 `some`，命中第一个 source 后停止
磁盘分类。分类谓词原样提取；状态、编译和加载仍枚举完整集合并排序。
没有新增缓存，没有绕开 FunctionSession、授权、generation、publication 或原工具执行。

## 回归和检视

- 新真实双 QuickJS guest 测试先 1 失败 / 2 通过：两 guest 均已执行，但第二目录仍被读取四次。
- 修复后三项通过，第二 guest 仍执行；撤销第二 guest 授权仍拒绝；关闭零发现；所有 source
  消失后直接走 core，不使用缓存答案。联合 manager / classic 窄测 3 文件 53 项通过。
- Node 初次因测试空数组推断 `never[]` 失败，补明确 `ModPluginSource[]` 后通过；Web 通过。
  修改文件 ESLint 无错误、无警告。
- 首次 `test:mods` 有一个 manager 注册工具测试 5 秒超时，已保留失败日志。
  独立限制两个测试 worker 后，更广原 30 轮集合加新增测试：170 文件、1,275 项全部通过。
- 代码检视确认八处仅修改存在性判断，off 仍短路，实际加载与所有 guest grant 校验不变。

Electron31 **156 项检查 exit0**，普通 out 已恢复，归档 `2026-09-23-electron-31-artifacts`。
关闭同路径读取 p95 2.8637/3.0709 ms，+7.2354% 超过5%阈值；noop1000 p95 9.0363 ms、pending0。
这些是回检事实，正式性能仍未通过。不将减少目录读取次数等同于达到最终 15 ms / 40 ms 性能门禁。
提交 manager 时仅包含 `source-presence-start/manager.ts` 快照到当前的增量，排除旧 Autobiz CAS。
