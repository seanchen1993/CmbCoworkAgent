# Thread incarnation 初始元数据解析复用

本窗只减少 `src/main/services/thread-incarnation.ts` 的重复 JSON 解析。每次调用方的
真实 SQL、文件状态、权限、lease、created_at 和其它完整检查全部保留，不缓存当前
数据库行、工作区路径、授权或匹配结果，不扩展 Source 框架。

`captureThreadIncarnation` 按原顺序读取 metadata 一次、解析 token、读取并 Number
转换 created_at。原返回对象保持可修改；模块私 WeakMap 只以本次自产对象为 key，
保存初始完整 string/null 元数据及解析出的 token。不会持有数据库行。

`matchesThreadIncarnation` 每次先读取实际 row.metadata。只有 expected 是原自产
对象、且完整 raw 文本严格等于初始文本时复用 token。改变文本、复制或独立构造的
expected 都走原解析；这些读取不刷新缓存。之后始终 Number 转换当次 created_at，
再按原分支读取 expected 当前 token/legacyCreatedAt。因此普通 expected 修改、
legacy 时间戳变化、同毫秒删除重建和异步恢复的原判定不变。缺行仍先返回 false。

新增 colocated 七项回归验证同文本复用、改变文本不刷新、clone/独立对象回退、
legacy 新时间戳、expected 可修改、getter/解析/expected 的原访问顺序和缺行短路。
原 `src/main/db/thread-incarnation.test.ts` 八项真实数据库测试不改，继续验证持久化、
同毫秒删除重建、异步 continuation 和 metadata 替换的身份边界。

本窗已获得 Root DESIGN1 与 Legacy 独立 DESIGN2。生产与新测试由独立源码审核后，
Root 执行窄门和旧数据库回归，再跑原四项 5 秒门。当前尚未实测，不宣称此次优化
能让剩余 Human 性能门通过；既有超时证据和预算保持原样。
