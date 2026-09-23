# 采集开始和检查步骤恢复证据

检查的第一次异步读取之前写入 capture.started，记录实际执行身份、插件 digest、generation 和配置指纹；binding 为 null，不伪造文件、需求或 checkpoint 证据。终结事实插入与相同 workspace/thread/turn/run/attempt 的开始标记收尾使用同一 SQLite 事务。completed 只表示步骤结束，不代表测试、评审或业务通过。重复事件被忽略时不能收尾其他 attempt；重启保留原 detail/attempt 并追加中断原因。关闭模式仍不创建门禁、采集记录或模型调用。

先增加 3 个失败测试（capture-start-red.log），实现后窄测 4 文件 55 tests 通过；补充相邻 attempt/线程隔离及重复记录不越界测试。真实 Node 进程完成 FULL 同步写入后被 SIGKILL，重新打开 SQLite，未结束步骤为 interrupted、已结束步骤保持 completed，没有 PASS 或自动重放。进程崩溃与存储回归 2 文件 15 tests 通过（capture-process-crash.log）。

Mods37：128 文件 1069 tests，通过真实 QuickJS/session、原生项目测试及背景任务回归；单独新进程崩溃测试未包含在此清单。Node/Web typecheck exit0；scoped ESLint 0 errors，仅保留 7 个旧格式 warnings。代码检视补充“采集返回后立即取消但尚未写 check.started”路径：终结结果也会收尾 capture.started，避免错误遗留 running。

完整 Electron34 exit0，161 checks，通过后恢复普通 out。2026-09-24-electron-34-artifacts 记录实际 guest 完成后两类 started 行均已结束；off 对照无门禁/证据 UI；文件修改失效、重载、原生 npm 测试失败阻止完成及修复后复检保留。该 bundle 不含随后开发的生产单调预算和 checkpoint 权限桥，不能替代它们的验证。

附带性能：真实 read off 对照 p95 2.7557 / 2.9531 ms，+7.1633%，超过 5%；noop1000 p95 8.8232 ms、pending0、child RSS 111841280→118927360。运行期间有窄测，非独占性能验收；既有正式入口 FAIL 继续保留，不能宣称性能达标。

只声明采集/检查生命周期恢复；不是 whole-workspace 事务，也不是真实 Autobiz 最终业务验收。工作树限定 Mods-v2，UAT、共享依赖和本地安装打包均未修改。
