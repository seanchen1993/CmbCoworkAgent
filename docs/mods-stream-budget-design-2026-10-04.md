# 流式规则的处理时间：下一阶段方案

工作目录仍为 C:/ai/CmbCoworkAgent-mods-v2，开发分支 codex/mods-v2。普通规则等待计量完成全部验收后继续此阶段，不在阶段边界停止。

## 用户看到的效果

模型逐段回答、命令持续输出时，组件可以边收到边整理。等模型或下一段不会耗掉规则自己的处理时间，也不把回答全部攒完才展示。取消和真正的进程清理继续有效。每段处理太慢时，保留已经执行的下游，不重复请求模型或启动进程。

## 官方依据与本工程实际基础

已核对 Claude Code 2.1.288 声明4793–4829：流式 turn.step 自身时间累计整个回答，yield 和读取下游不计；process.spawn 每次拉取按新片段重新计量。恢复自身1秒，同样排除SDK/下游等待；next.budget读取实际当前预算。

本工程 turn.step 目前是一段持续的真实 guest invocation，通过 stream.yield 的有界背压暂停；process.spawn 是实际私有游标，每次 next 建新的短期调用。上一阶段已经有宿主单调计量、真实RPC回执停钟及逐帧同步预算。游标的预算读取必须指向当前实际拉取帧，不能读已经关闭的open帧；该绑定已加回归，目前仍0/Infinity，不算流式计量完成。

## 实现约束

- turn.step 在原真实持续调用上启用自身10000ms，保持跨回答累计。stream.yield 和 stream.pull 等宿主请求沿原真实回执停钟，主动clock等待仍计入。恢复重新创建真实调用，1秒累计，不借原已关闭调用续命。
- process.spawn 普通open/next采用自己的实际10000ms计量；每次next新建帧自然重置。恢复游标持续保持恢复身份，每次恢复next使用1000ms，不能因open后metadata消失而变成普通10秒。return清理仍用原短硬期限；不得使已耗尽的旧游标继续工作。
- 两个不同组件、两个游标和并行请求各自独立。宿主选择预算身份，事件输入和作者名称不能选择另一帧。next.error.kind/budget和同步next.budget保持一致；0/Infinity仅用于真实未计量入口。
- 显式短timeoutMs和原取消优先；turn.step继续有界总等待，process长寿命不被一个120秒整个进程期限错误杀掉，每次实际拉取仍有界。普通主任务实际模型/进程的原上限保持，不能为了停钟扩大权限。
- 总期限和取消必须覆盖 channel.next、guest结束、下游stream.next、stream.return及恢复/保留的等待。实际下游忽略abort时，调用者仍按期限返回；底层实际操作与迭代器由原transport/activity跟踪到真实finally，不假装已经空闲。迟到只清理，不回填、不重放。
- 无匹配组件的实际原模型/进程保持原入口和生命周期。早退、异常、恢复和用户取消继续完成真实清理；已开始的模型/进程不重复执行，chunk与最终结果分开传递，有界背压不放宽。
- SDK请求权限、原来源检查、内存与CPU片段保持。普通callback/UI/provider等尚未接入的私有入口分别核对，不把本阶段范围扩为全部官方生命周期。
- 宿主游标还须保存实际在途pull/return回执及未消费结果。旧Hook发起首段拉取后未等待就失败，恢复沿同一回执交付首段一次，不能排第二次pull而丢首段。宿主串行化真实拉取；旧帧不再接纳，新的恢复身份只认同一实际下游未消费结果。必要时加入私有消费确认，不根据作者输入猜某段已交付。整链取消/硬终态后迟到仅清理，不再交付。
- 自身预算耗尽只使当前可选Hook缺席，不用旧frame的abort取消整个下游。旧Hook的finally不能提前close仍需供恢复的原流。真正用户取消与共享硬期限才关闭整链。实际return只排一次；finally如果还yield清理块并继续等待，实际占用须持续到真正done，不能因caller race拒绝就释放。

## 必须验证

1. 真QuickJS turn.step两段自身工作分别低于小预算但累计超过：第二段缺席，既有下游继续且模型调用1次；停在yield和慢next期间预算不下降。
2. 真process游标每段都低于小预算且总和超过，仍各段成功；预算读取属于本次真实pull，返回后读取旧scope拒绝。恢复1秒身份保持，不重启进程。
3. 两插件链、多个并行游标、clock主动等待、SDK取消、纯未完成Promise和CPU无限循环，保持原错误与资源收口。
4. 实际下游next/return不响应abort：调用者到期拒绝，真实activity仍占用至actualfinally，late不回填、native调用次数1。
5. 已有真实流式/进程/模型授权、内容保护、完成检查、重载和任务连续性回归；真实Electron慢模型逐段显示及取消验证，性能检查首段延迟和有界缓存。
6. 真Guest先发首段pull但未等待就异常/CPU失败：恢复得到未消费首块，再得到后续块，原生provider/进程调用1次。首块后own耗尽且旧finally尝试close，仍完整续读第二块。return的真实finally先yield清理块再等不响应abort的操作，到期caller拒绝但actualactivity保持至实际done后才为0；重复close不得重复排return。

两位独立方案评审通过后实现；所有尚未完成的指标保留明确状态，不把尚可适配的缺口写成框架限制。之后继续session.end共同短退出期限、消息/附件链和其它剩余可适配能力。

## 真实进程验证发现的补充方案

Electron 中外层 command.run 创建并读取进程时，process.spawn Hook 的每段自身计量正确，但 SDK 的 resource.pull 走独立模块通道，没有扣除外层仍存活规则的实际等待，导致等待11.2秒后命令可选失败而回退空结果。这不是框架限制。

私有 bootstrap 的实际异步scope 增加闭包内 budgetToken。resourceCall 在发起实际模块RPC时，只把仍存活当前scope的私有token传入native模块通道；作者代码不能读或选择token。native根据frames中的真实对象创建停钟回执，检查原实际墙钟期限与自身时间后才能停钟。实际模块reply使用已有waitReceipts关闭回执；frame结束先关闭计量，迟到只原模块清理。不存在/已结束scope不借另一帧，只保留已有授权模块资源的独立生命周期。不给资源延长授权，也不改变模块signal、权限、取消和活动占用。clock sleep/主动clock等待仍计时。

新增真QuickJS外层command小预算读取真实慢进程（不缩放process自身时间）；验证第一次/第二次pull以及最终结果完整，现有后台创建后输出、取消、撤权/重载、未启动return等全回归。真实Electron11.2秒进程输出须通过，不能只看process Hook内部budget日志。两位方案复核通过后才实现。
