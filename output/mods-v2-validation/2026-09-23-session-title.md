# Classic sessionTitle 实际效果验证（2026-09-23）

基线 314518b0，host v51，仅 Mods v2 工作树。不是业务验收或 checkpoint 推进能力。

## 实现与检视

- 只有 Function Mods 的 classic.SessionStart / classic.UserPromptSubmit 返回标题进入此效果；原 output publication 完成后才交给 host，通过原 DB / ThreadMutationLease / 锁提交，原 threads:changed 刷新侧栏。
- DB updateThread 仅新增一次待决观察 Map 查询，不改原字段/返回/事务持久化。用户同一毫秒 A/B/A 重命名也会让旧提议失效；其他 metadata 更新不误作标题修改。
- 绑定 thread incarnation、DB 实例、原标题、运行 authority、grant、epoch、generation、signal。等锁时取消立即结束；FunctionSession lifecycleSignal 同时取消已退出 guest 但仍等待 host 锁的效果。锁队列维持原先顺序，迟到进入的已取消请求不会写。
- 512 字符单行显示限制，Unicode 控制字符和行/段分隔符拒绝；空白或非法标题不更新。关闭/未授权路径不捕获标题提议。
- 只改标题，不改模型输入、transcript 或 checkpoint。提交后若窗口已不可用，通知失败不触发重复提交。所有观察记录在完成/失败/取消路径释放。
- 矩阵保留 partial：legacy settings title、SessionStart 其他 source/initialUserMessage/watchPaths/reloadSkills 尚未实现，不能据本字段宣称整个事件完整兼容。

## 失败先行与回归

- 新 helper 模块红测；manager 实际效果与撤权 2 项失败；DB重开、stale错误类别、等锁取消、guest外host等待被替换、Unicode分隔符各有失败日志；matrix新增声明红测。
- 初窄测3文件55项通过；等待锁/替换修复后选中6项通过；最终helper/DB incarnation/classic session 3文件16项通过。最终Unicode+matrix2文件22项通过。
- Mods25 扩大到原数据库目录：157文件1213项通过，119.89秒，maxWorkers4。
- Node/Web最终 exit0。初lint发现新增 no-control-regex 错误，补Unicode用例后使用Unicode字符类别修正；最终作用文件 0 errors / 299 warnings，包含局部新增代码格式调整。Node/Web 最后复查仍 exit0。
- 聚焦 Electron1：8checks、exit0，普通out恢复。真实SessionStart与UserPromptSubmit标题、原模型输入、原侧栏刷新、用户A/B/A、renderer重载、相同任务off、取消/撤权均通过。截图已查看，归档2026-09-23-session-title-focused-artifacts。
- 综合 Electron25：142 checks、exit0，普通out恢复，归档2026-09-23-electron-25-artifacts。其初始bundle在最后等锁取消和Unicode修复之前；最终聚焦 Electron2 又通过8checks、exit0，普通out恢复，归档2026-09-23-session-title-final-artifacts。
- 最后增加相同标题不重复写入/通知的失败测试并修复，最终3文件28项通过。

## 性能与未完成门禁

本轮同路径读取 absent/off p95 为3.0699/3.0471ms（-0.7427%）；noop1000 p95为9.2868ms，pendingRequests=0；不是正式五轮预算通过。原正式五轮入口性能失败仍未解决；完整应用性能和长稳、真实Autobiz任务演示、GitHub Actions安装包尚未完成。HTTP协议模型测试只证明应用链路，不是业务PASS。
