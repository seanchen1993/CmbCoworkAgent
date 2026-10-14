# Claude Mods 兼容补齐：会话状态与基础编码

本轮基线：开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，`codex/mods-v2`。保留既有未提交改动。上游固定为已提取的 Claude Code 2.1.283，不将公开 tag 的旧声明误作完整内嵌声明。

## 目标与分批

1. 补齐具备实际用途的纵向能力：`$.state.get/set` → `claude-code` 模块的 atom/derive/memberOf/read/update → 真实 UI 自动刷新。插件能共享会话状态、并发安全修改、按版本计算派生值，热重载不丢会话值。
2. 补齐 Hooks 与 Client 的 UTF-8 TextEncoder/TextDecoder，独立于宿主网络、文件、模型能力。其他编码标签明确拒绝，不能宣称支持完整 Encoding Standard。
3. 同步 SDK 可用性与新版本增量矩阵，提供示例、功能回归、进程隔离测试、生产 Electron E2E、性能与存量影响结论。

本轮不能据此声称 2.1.283 全兼容。后续仍需 process.spawn/session.send、完整标准全局对象、事件生产触发、完整类型生成与其他界面表面。URL、AbortSignal 定时器和 structuredClone 必须独立完成规范及沙箱评审，禁止采用看似可用但语义错误的简化替代。

## 状态与授权契约

- 会话状态独立于持久 `$.store`；按工程、线程隔离，热重载保留，结束/销毁会话释放，不跨应用重启恢复。
- 首次读取版本为 0，无 value；成功写入版本加一；ifVersion 失配不写入、不重绘，返回当前版本。受限 JSON，限制条目与总字节；写入前预校验，不允许配额失败后的部分更新。
- 任意获授权插件可读；仅 owner 能发起 set；state.get/set 经过现有操作 hook、审计和内容保护。plugin/key/id、ifVersion、previous 由宿主固定，hook 只能改 value；取消、撤权、身份失效时不得提交。
- 当前调用作用域在首次 get 时固定状态快照；同作用域后续 get 使用该快照。set 成功或 CAS 失配后都刷新该作用域快照，使 update 重试能读到新版本。依据提取宿主 Hxe/mbr/gbr，而非仅根据声明推断。
- 渲染调用链禁止 state.set，包括经其他 SDK/嵌套 hook 间接调用；正常按钮回调允许。订阅按真实绘图生命周期绑定，卸载/重载解除旧订阅；不要触发无关绘图。先后读写交错不能让旧快照覆盖后续失效标记。
- 纯 guest helpers 根据已提取实现行为独立编写：冻结描述和 initial；shape 不匹配使用 initial；memberOf 绑定 requestId；derive 以源版本缓存但每次仍读取依赖；update CAS 最多 64 次。错误与取消不吞掉。
- 仅对白名单 `claude-code` 命名导出开放静态虚拟模块。其余 bare import、动态 import、Node 和网络访问仍拒绝。完整官方类型注册/静态字面量契约分析未实现时须明确标记部分兼容，不能隐瞒。
- 运行时能力变化更新 host revision，旧授权不能隐式获得新能力；兼容 profile 不自动升级成全量 2.1.283。

## 编码契约

纯 QuickJS guest 注入，共用同一 Hooks/Client bootstrap，无 Node 对象跨 VM。TextEncoder 支持 encode/encodeInto（Unicode 标量、孤立代理替换、容量不足不拆分字符）；TextDecoder 支持 UTF-8 label、fatal、ignoreBOM、stream、ArrayBuffer 与 view offset；无效 UTF-8 与 BOM/流式边界对照 Node 标准实现。受现有 VM 内存/CPU预算约束。

## 验收门槛

- 两位 agent 在实现前评审；有阻断项先修改方案。
- 狭窄回归覆盖状态隔离、CAS并发、owner/pinned字段、嵌套渲染写禁止、取消/撤权、配额原子性、重载、订阅清理与交错；helper 深冻结/shape/cache/member/retry与实际编译导入；编码标准对照。
- utility-process 使用生产隔离运行时，验证 await 后语义、Hooks/Client、撤权/销毁。
- 生产 Electron E2E：安装授权的真实插件，以按钮更新状态，其他绘图不用手动 invalidate 自动改变；重载保持值、撤权不再执行。编码通过真实命令与 Client 回调展示。
- 代码检视由两位 agent 复核；类型、构建、新代码 lint、全库 Vitest（Node22、2workers）和相关 standalone；对比既有失败基线，不改松测试以制造全绿。
- DIY 核心、浏览器、Electron 流程回归；记录性能样本，明确微基准不能替代历史 TTFT/长期内存验收。

## 评审记录

- compat_plan_review：首次要求修正读取快照生命周期；根据提取宿主修订后明确通过。
- compat_test_review：通过；补充最终写值配额校验、缓存会话隔离、编码品牌检查及标准差分向量。
- 两位通过后开始实施。最终代码评审及实测结果另写交付记录。
