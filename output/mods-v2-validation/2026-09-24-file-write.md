# fs.write 原生文件写入验证 — 2026-09-24

> 2026-09-24 证据更正：初版 Electron helper 将安装 ID 传给接收插件名称的 revokeFunction，实际只证明会话失效取消，未证明持久授权撤销。现改用插件名称，并断言状态为 needs-approval；实际重跑结果见[撤权验证更正](2026-09-24-function-revocation-e2e-correction.md)。既有 native/guest 撤权测试不受此测试传参问题影响。

基线 fbbc988e，工作树 C:/ai/CmbCoworkAgent-mods-v2 / codex/mods-v2。本次新增 SDK 写入经原 FunctionSession、ModsManager、审批、LocalSandbox、runtime/authority 和实际线程租约；host revision v58。没有更改 UAT 或共享 node_modules，安装交付继续使用 GitHub Actions。

## 失败先行与修复

1. 实际 QuickJS/session SDK 缺失红测；旧普通包 Electron 返回 `WRITE_ERROR:normal:not a function`。实现位置参数与 operation core 后，hook 改写的文件实际落盘一次，原审批看到最终路径和文本，host:write_file durable receipt 绑定插件及线程。
2. 实际 native 集成发现：逻辑 leased=true 但物理租约已释放时仍可写入。绑定宿主入口的物理租约，原 manager assertEpoch 在审批/执行/发布边界复核。
3. 同 ID 与相同时间戳重新领取租约的失败用例证明仅字段比较不足。改为对原 activeLeases 私有实例的捕获判定；嵌套执行不能刷新旧实例。没有改变原 lease API 的领取、交接或释放语义。
4. 审批期 release/handoff/revoke/cancel 检查真实文件不存在、原审计无成功回执。类型检查发现测试初稿错误调用 store.revoke（会用方法不存在的异常错误地满足 rejects），已修为真实 manager.revoke，并增加授权确实 disabled 的断言后重新通过。

5. 检视后新增跨 thread/workspace 嵌套和 expired detached continuation 两项失败测试，均先复现旧 lease 可被继承。仅同一且仍活跃的宿主作用域可继承/捕获新 SDK 写入租约；显式跨 scope 使用原 withFreshFunctionExecution。修复后含真实 runtime authority 的 4 文件 57 项通过，最终 Node 与新代码 ESLint 再次通过。

## 已完成验证

- 窄测 4 文件 75 通过；修正审批撤权测试后专项 2 文件 7 通过（49 非目标跳过），最终整套待下方结果。
- 原生 Electron 专项 7 检查通过：写入/审批最终参数与一次回执、拒绝、immediate 只读、自动模型 hook 拒绝、延迟撤权、关闭原生读取。`2026-09-24-fs-write-electron-green-artifacts/`；截图已检视。
- 真实 utility process 41 检查通过；原 local-thread-run-lease standalone 6 检查通过。
- Node/Web/helper TypeScript 通过，普通构建通过。ESLint 0 错误；存量 basic-sdk 2/session 2/E2E runner 92 格式警告与 HEAD 数量一致，新模块和 helper 无警告；diff check 通过。
- 完整 Mods47：139 文件 1233 项通过。后续新增两个作用域失败用例并修复，最终 Mods48 **139 文件 1235 项通过**，exec53547 exit0。
- 完整 Electron：192 检查通过，exec10251 exit0、普通 out 已恢复；该轮早于最后的同作用域继承补丁，补丁后最终 Electron 写入专项 **7 检查通过**，exec55029 exit0；artifacts `2026-09-24-fs-write-electron-final-artifacts/`。
- 独占标准性能 smoke 已完成（exec21647 exit0），目录 `desktop-performance-2026-09-24T00-35-51-318Z-smoke-fbb63130/`。off/on 各 2 样本：TTFT p95 109.3/178.9ms，增量 **69.6ms**，吞吐比 1.006525，约 1 秒 idle 增量 2.158447 单核百分点。qualified=false、passed=false；短样本不能证明正式性能通过，没有与测试/build 重叠。

## 检视和兼容边界

输入与原生结果单独校验；不将 isError 丢弃为 void 成功。原参数 16000 JSON 字符上限保留，不冒称上游 4 MiB 支持。Automatic hook、immediate 与无租约 UI 回调拒绝写；不通过新增 SDK 提升原权限。

正常可选 hook 出错时仍遵循原 dispatcher fallback；合法短路 void 并不证明物理写入，empty deny 阻断。下游真实失败不会重试同一次原生写。晚到权限失效不会发布成功，但没有回滚已经落盘的承诺。SDK 实际可调用仍 partial/bounded，业务验收与 validator/checkpoint 证据边界不变。

正式 TTFT/ingress 关闭预算、两小时10000事件 soak、剩余兼容项和 Actions 安装验证仍未完成。此报告不能替代业务最终验收或最终发布门禁。
