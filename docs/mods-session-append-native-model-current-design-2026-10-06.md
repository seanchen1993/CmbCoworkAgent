# 模型输出同来源完整检查的窄优化

最新双子任务实测约 6273ms，原 5 秒仍失败；实际 SQL 已缩为 fresh 完整快照，
不能靠延长时限或缓存权限来通过。接下来只优化已证明是同真实来源的重复完整检查。

## 安全边界与范围

Adoption.guard 当前先 runtime.assertCurrent，再 input.assertCurrent，再 Store fresh。
真实模型的 Host 自造 current 本身通过真正 Manager 的 private PolicySource 执行完整
policy/runtime 守卫。前面的同 runtime.full 因而重复。Source 证明必须由自造 current
模块自己的 private WeakMap 按原函数地址认证，不接受通用 register(callback)、公开
标记、名字、相同 ID 或 claimed coverage。Side-only 方案另由其原私有模块认证。

这一阶段只接受真实完成 model_request slot 与 same actual runtime 的原 policy-source
certificate，保留它们的原回调与完整 body 核验。未知、Generic、ToolHuman、NativeInput
和普通 Tool 仍原路径。模型和工具仍只执行一次，原 public Hook 预算、Worker 原保护、
Keeper、原 Saver writer、取消/撤权及完整内容不变。

## 自造模型 current

新增独立模块只导出 self-building factory 与只读的 exact current reader，不提供外部
callback 的认证接口。factory 固定实际 slot/view/raw 对象、runtime、真正 policy admission、
原 uuid、原首次绝对 cut、原 signal、Host.failed latch 和原 captured original digest。
首次外部 callback 前安装 once/reading/failed latch；Proxy/getter 输入不触发用户代码。

factory 通过原 slot 私表确认真实 model_request，取得 private PolicySource 并核 exact
runtime 地址。原 digest 只是固定比较常量，需从该真实 raw slot 完整 typed 捕获复核，
不能靠 caller 传入 digest 获得资格。原完整 AI/chunk 字段、constructor normalization、
step-limit notice 的已有语义保持。没有对应 genuine certificate 就保留 Host 原 guard，
不能把通用 policy.assertCurrent 包装成有资格的来源。

自造 current 的每次调用保持原 Host 语义：slot 纯结构→真正 policy/runtime full→
slot 纯结构+policy tail→完整原 typed raw/body digest→同一 full/tail 再核→Host latch/
cut/signal/raw/policy/slot 最终纯尾。这个完整检查从不复用上次通过的结果。独立调用
仍执行原 Source callback。捕获重入即 sticky fail，外层不能在 catch 后继续成功。

private reader 按原函数地址+exact runtime 取得 capsule，拒 clone/wrapper/foreign runtime。
Adoption 在 bind 之前选择原函数。命中则直接执行该 self-built 原闭包（不读取函数
可变 own bind/call 属性），然后原 Store fresh，最后 capsule.assertTail。只有该分支
省去最前一个被同来源完整覆盖的 runtime.full。所有未知分支保原链；不省 Keeper、
独立 Source、raw 捕获、Store 或任何异步后的最后新检查。

## 源码窗口和实际验收

Root 独占新 native-model-current.ts/test、Host 的 model current 选择窄段、Adoption
认证分支。Legacy 的 Side-reader 及其分支保留，不覆盖其改动；Latest 的 Host SSE
prepare/cache/close/drain 段独立。源码改变前需两位独立设计通过，之后两位源码检视。

真实边界测试必须使用原 Node/Manager/PolicySource：地址伪造、相同值、wrapper/clone/
foreign runtime、own-bind getter0、捕获/调用被catch的重入；末 Source 改 body/metadata/
policy epoch/physical binding/Host close时零错误 ACK、原 writer/下一模型拒绝。
完整正文不缩，原 5 秒不变。原未知/generic guard 次数保留；genuine 只去掉已说明
的一个重复 full。串行跑真实并行子任务、resident Hook+HTTP继续请求、MainHost/
Side/Human/Tool/SSE回归、类型与最后实际 Electron流程，性能用独占测量确认。

当前仅提案，无性能收益或新测试通过声明。没有框架不能实现的证据，继续补齐。

## 2026-10-06 源码落地范围

Latest 与 Official 两位独立设计通过，Legacy 对实际 runtime-slot 增量第三次独立通过。
初期仅 exact completed AIMessage 进入优化；AIMessageChunk 保留原完成消息捕获与完整
检查链路，其含 Source 回调的捕获不能作为纯尾使用。这里的范围收缩没有裁剪 chunk 数据。

Node 安装时固定原 options.runtime。实际 Work 在 once 记录之后、首个外部回调之前，
固定原 domain.runtime 或该 main runtime。只读 slot-runtime 接口只走 slots → 原 Work
私表，先执行原 slot 纯结构检查，再取固定 runtime 地址。相同配置、公开 slot/view、
相同 ID 和已完成消息的拷贝不能推导 runtime。两个真实 runtime 交叉配对同样拒绝。

Root 已落 self-building guard、runtime pin 和 Adoption 精确函数地址选择；Side 分支保留。
完整 raw 捕获、真正 policy full 和同步最后纯尾保留，不提供 register(callback) 接口。
现正做两次独立源码检视与真实回归；尚无当前性能门通过声明。
