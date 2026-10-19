# 预览手工确认弹窗修复

2026-10-19，gpt-6.1-sol/xhigh唯一实施，按root授权从clean `ae702957`新建`codex/bot-preview-manual-dialogs`，保留M03分支和旧验收结论。本次仅launcher、必要测试与本记录；未操作目标树、用户profile、运行中App26645/Java/DB/会话91775，未启动App/DB或调用模型。

因果：`PartnerDevPanel`只在原生`window.confirm`返回true后调用`startExpert`。原预览launcher始终保持Playwright Electron连接，但firstWindow没有dialog监听。已安装Playwright `lib/server/dialog.js`的`DialogManager.dialogDidOpen`在无handler接管时调用`dialog.close()`，confirm最终dismiss；`lib/client/browserContext.js`在无客户端listener时也dismiss。这会让确认变成false，不产生startExpert IPC错误，符合root观察。这里确认了自动取消机制，实际CUA交互仍由root验证，不把无App测试冒充原生点击通过。

修复：仅预览firstWindow在任何页面交互前调用`retainManualPreviewDialogs`，注册不处理dialog的监听，完全不调用accept/dismiss/evaluate或修改生产`window.confirm`。订阅保留至page close，再只移除本helper的dialog监听；不提前取消尚待用户决定的弹窗，不影响原App→服务关闭顺序。没有自动授权/启用动作。

验证使用固定Node22：`/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`。

- `node --test tests/bot/service/partner-preview.spec.mjs`退出0，9/9，`/tmp/partner-preview-dialog-test.log`。新增测试直接使用已安装Playwright DialogManager复现无订阅自动close；加入预览监听后confirm/alert/prompt/beforeunload均不自动处理。另测监听持续到page close、只移除自己、其他page/监听保留、App先于服务关闭。没有启动浏览器或模型。
- `node --check deploy/dev/service/partner-preview.mjs`退出0。
- `node --test tests/bot/service/partner-preview.spec.mjs tests/bot/service/partner-http.spec.mjs`退出0，19/19，`/tmp/partner-preview-dialog-regression.log`。
- 仓库Prettier已格式化launcher和测试，`/tmp/partner-preview-dialog-format.log`；`git diff --check`通过。

交付后停写，root正常合入并重启原预览，用原生CUA验证“启用本机”仍需人工确认、取消不启用、确定才进入既有授权流程。未修改M03产品业务、模型配置或旧验收结论。
