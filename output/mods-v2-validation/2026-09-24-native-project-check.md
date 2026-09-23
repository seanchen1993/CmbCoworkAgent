# 原生项目完成检查：2026-09-24

## 改变与边界

生产路径不再以独立 execFile/npx 执行完成检查。应用项目配置通过 FunctionModsManager →
ModsManager → 原 invokeFunctionCapability/LocalSandbox 执行；保留原 authority、grant、lease、
配置 epoch、原始 turn、审批、输出保护和执行账本。没有宿主适配器时明确失败，无备用执行器。
原背景任务资源管理被提取复用，公开背景任务接口未变。测试专用独立 executor 只在 tests/support。

固定入口选择有界读取 package.json；选择 npm test:unit/test、test:e2e/e2e 或已有本地入口，
不拼接脚本正文、不下载依赖。宿主 ALS 固定最终命令/cwd及调用身份，classic PreToolUse 改写不能替换测试。
真实退出码和执行账本共同决定结果，证据关联 executionId；输出展示和插件文字不能生成测试 PASS。

实际进程红测发现 Windows shell 被取消后 npm 孙进程仍能写 late.txt。修复仅让已在原审批边界验证的
宿主项目检查使用现有 Windows Job controller；不改变普通命令或关闭 Mods 的执行方式。
取消/撤权/运行时替换/租约交接均杀掉真实测试进程，未出现迟到写入或成功记录。

这是应用执行能力与集成证据，不是 Autobiz 真实业务验收。Electron 修复对照本轮由测试驱动物理修改
项目文件后重测，不能称为模型自主修复。测试 runner 自身仍需真实业务断言；零退出码不是业务验收。
Node/npm 需在环境中可用；不声称支持任意语言或自动安装测试框架。Windows无沙箱路径已实际测试；
受限 token sandbox 的深层进程取消需要额外验证，不以无沙箱结果代替。

## 验证

- 初始红测：2026-09-24-native-project-check-red.log；缺失计划/输入约束/宿主方法。
- 第一轮真实 guest/session 与固定 validator 集成：6 files /59 pass。
- 对抗红测：2026-09-24-native-project-check-adversarial.log，4个孙进程迟到写入失败。
- 修复后对抗及原生背景任务/Windows Job 回归：3 files /42 pass；包含真实npm失败退出2、权限拒绝、
  classic命令改写拒绝、classic输出伪PASS仍失败、取消/撤权/替换/交接，以及关闭Mods的原生背景任务。
- npm run test:mods：2026-09-24-mods-35.log，**125 files /1045 pass**，不是此前自选174files清单。
- Node/Web typecheck exit0；初次Node发现modId可空，已修复。ESLint scoped exit0，既有格式warning保留。
- 真实 Electron focused：2026-09-24-native-project-check-electron.log，**8 checks exit0**，结束后普通out恢复。
  关闭模式不执行失败测试；开启后实际npm断言失败阻止原完成；修复文件后二次原生执行生成新证据。
  旧文件失效、renderer重启、报告模式capture.failed仍通过。截图已检查。
- artifacts：2026-09-24-native-project-check-electron-artifacts/native-project-check.json/png。
- 全仓 npm test 首轮：576 files，551pass/25fail；4369 tests pass/60fail/5skip，另2个worker测试异常。
  全部25失败文件以maxWorkers=2复跑后：15pass/10fail，269pass/27fail/2skip，无worker异常。
  33个首次超时/时限失败未复现；新增1个测试专用shell退出后cwd未释放（EBUSY）得到修复：
  fixture只直启已知Node入口并等待close，不影响生产路径；相关2files/34tests重新通过。
  剩余26项属于此前在0273980c导出基线已复现的9组问题（IDE/Windows路径、IM、Chrome缺文件/socket、
  harness guard和主题规则）。因此仍明确 **全仓 npm test 不绿**，且&&后standalone suites未自动运行。
- 最终Node/Web均exit0；scoped ESLint **0 errors/37既有格式warnings**，本次新增段已格式化。
  test-only close修复后再单独复核Node。
- 代码检视：未绕过原完成循环/工具审批；没有增加guest shell参数入口；只宿主已验证调用可开启
  Windows进程容器；全部清理在finally；普通/Mods关闭路径保留原行为。

## 性能与后续

本能力关闭时不创建完成门禁，不运行测试、不产生测试执行记录；Electron真实对照验证。
没有将本次Electron断言称为正式性能通过。先前正式performance full2的off窗口不足300000ms，
且TTFT p95增量179.2ms超过40ms，仍不合格。单调时钟harness修复和正式重测独立处理。
Autobiz自动checkpoint推进、真实业务演示、Actions产物验收、2小时/10000事件正式soak仍未完成。
