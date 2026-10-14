# Shared线程身份查询的最小性能窗

这里只优化已经执行的数据库查询，不减少权限、authority、lease、取消、Scope或原source
callback检查。SDK29、Shared driver、消息保护与完整CP/23列门均不改。

## 当前证据

Shared真实tool完整功能在显式30秒诊断中通过全部输出/CP/member/23断言，19.227秒；
原5秒门仍失败。Root采样中的三个getThreadCore调用链分别约475/391/237ms，
均只消费created_at和metadata。不能把该诊断当原验收通过，也不承诺本窗足以达到5秒。

## 复用的真实读API

`readFunctionConversationThreadIdentityCurrent(database, threadId)`已经存在于
`src/main/db/function-conversation-thread-identity-read.ts`，执行
`SELECT created_at, metadata FROM threads WHERE thread_id = ? LIMIT 1`。
其缓存只有本database的statement，每次调用都真实read一次；重入另建临时statement，
异常只清该statement缓存，包含undefined异常；没有行/匹配结果/权限缓存。

两个源在原getThreadCore接点换为
`readFunctionConversationThreadIdentityCurrent(getDb(), originalThreadId)`。
getDb仍在每个原读接点求值，SQL仍发生在同一callback前后位置，不提前读、不合并两个
连续读、不把一次thread结果借给另一个检查。缺行仍null，metadata完整原字符串不截断，
legacyCreatedAt仍由原matchesThreadIncarnation处理。公共getThreadCore与其六列形状不变。

## 精确候选生产范围

1. `conversation-shared-source-current.ts`：guard中的父物理thread匹配，以及family pair
   assertDestination中的destination incarnation和完整metadata比较，两个接点。
2. `conversation-child-family.ts`：只shared路径assertShared的checkpoint、destination
   匹配和之后独立的destination metadata读，以及assertSharedDataCurrent两个匹配，
   共五个接点。普通child路径的两个getThreadCore调用不改。
Coordinator另有Root/Legacy已批准的更小guard窗，归Legacy独占，不在本窗修改其余
七个接点。当前精确授权候选只有上面SourceCurrent2+ChildFamily5，共两个源七个接点。

这两个源只增加现有helper的value import与必要getDb import，不产生新授权注册、
caller coverage、Source或SDK关系。Helper执行与旧fresh SQL一样可能失败，原catch、
sticky failure、原错误值和检查短路顺序保持。

## 验证边界

保现有helper真实DB十二定义及公共getThreadCore形状回归；在两个源的现有真实Manager/
parent/Shared/Scope夹具中保外writer改变metadata/token、legacy created_at、delete/recreate、
同thread不同destination、closed数据库和重入失败的拒绝。测试若原来仅spy公共
getThreadCore观察这些内部读，应委托本次真实helper原函数计数，不用fake row补来源。
原Source callback/SQL读次数不减，Root跑原8+54、原完整tool5秒及typecheck。

本稿仅两源七接点窄DES；得到两票后的维护窗口才落生产或测试。Destination显式mappingKeys/
pragma优化不是本窗的一部分，若需要另行说明其旧schema测试合同。
