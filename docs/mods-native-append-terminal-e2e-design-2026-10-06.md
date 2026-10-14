# 原生追加桌面测试的真实结束判定

实际 `native-append` 测试发现：看到保存的回答和停止按钮消失，仍可能随后收到运行错误。
当前测试有误判，不能把早期 PASS 标签当整轮成功。此方案仅修改测试，生产源码保持。
Latest 和 Official 两位独立评审已通过真实结束事件观察的范围；消息回存冲突诊断不在
这两票中，不使用 Electron 的私有 handler 表取得或替换入口。

测试向 `verifyNativeAppend` 传入实际 ElectronApplication，以 `app.browserWindow(page)`
取得这一个页面所属的真实 BrowserWindow。在 reload 后、首个 composer 提交前，通过
仅测试构建的 `mods-e2e` 模块为该窗口安装观察器。模块导入原 Electron ipcMain 和原
`resolveAgentStreamRequestChannel`；普通构建不包含该测试模块。

观察器以 `prependListener` 记录原 `agent:invoke`、`agent:resume`、`agent:interrupt`。
只有原 event.sender 严格等本窗口 webContents 且 threadId 等本实际测试任务，才记录
原 streamRequestId 和由原 helper 计算的 request channel。不改请求，不启动任务，不
取得运行、权限、文件或模型来源资格。

只在同一个 webContents 安装 `send` 的观察 wrapper，保留原方法及原 own/inherited
descriptor。wrapper 对已记录的真实 request channel 记录 `error` / `done` 原事件，
以固定原方法、原 this、原 args 同步委托一次，保持原返回和异常。error 独立累计；后续
done 不能把 error 清除。其它频道直接委托，不记录正文、提示词或凭据。

每次 composer 提交前固定观察游标，之后仍满足原 HTTP 次数、真实保存内容、停止按钮、
工具审批及原调用次数等全部断言。另要求至少有一条真正新请求，当前新请求链所有
error 为零且最后请求收到 done。若真实审批产生 resume/interrupt 新请求，也必须检查
其真正终态；不能仅凭第一次请求的提前 done 通过。实际 error 立即使测试失败。

原 ID-less、padded-ID 的直接调用已有自己的真实结束回调，全部保留。最终证据加入
每次真实请求的种类、ID、频道和终态计数，不用人工生成的回调代替实际事件。
失败也保存证据。finally 精确恢复本次 send 的原 descriptor、移除本次全部 listeners，
测试服务和应用继续原清理；不保留全局 handler、不增加生产 IPC。

预计仅改三处：`tests/support/mods-e2e-entry.ts` 的测试专用导出、
`tests/support/mods-native-append-e2e.ts` 的观测和验收、`tests/mods-e2e.spec.ts` 的 app 参数。
整库测试期间这三处仍冻结；实际源码检视和桌面执行在测试窗口结束后完成。设计通过
不是修复完成，也不能把当前未通过的桌面日志改写成通过。

## 补充：晚保存错误也必须为零

第一次真实请求结束检查已通过，但主进程随后仍出现 3 次编号保存冲突。因此再补充
一个测试条件：读取这次隔离应用真实 `data/logs/main.log`，只累计四种固定的
`CanonicalTranscriptEcho` 字段错误，不记录消息正文或编号，不把缺失日志当作零。
原六次对话、实际 HTTP、数据库内容和完成事件的全部条件通过后，还必须累计为零。

应用和模型服务按原流程实际关闭以后，再读同一个日志一次。晚错误、日志读取失败
或关闭失败都使最终证据的 `complete` 为 false。保留原错误和清理过程，不加等待时间、
不更换生产入口，不放宽数据库检查。新增范围仅是上述 helper 的日志统计及 spec 的
原参数、关闭后检查。Latest 和 Official 已实际检视这两处新增源码并通过；桌面执行
结果尚待复验，旧三次错误的证据继续保留。
