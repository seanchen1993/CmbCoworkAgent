# DevClaw 伙伴：可操作本地开发版（R01-A7）

本轮只用模拟模型，不使用已有API密钥，不调用真实模型/真实招乎。服务端是现有Java单体的可选开发启动入口，不是生产WSS/云Runtime。App是新独立“DevClaw伙伴”页，原机器人管理不变。

## 启动

在集成工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`，使用Node22、已配置JDK8、任务专用Docker/Colima环境：

```sh
npm run test:bot-service-build
npm run dev:bot-partner
npm run status:bot-partner
npm run dev
```

如果系统默认Node版本不是22，先将本机Node22目录加入PATH。本任务现成目录为 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin`。

`dev:bot-partner`只管理独立项目 `devclaw-bot-partner-dev` 的MySQL5.7数据卷/私有回环端口和本地Java控制进程。复用任务Docker配置/profile，不读取原MySQL/ES/S3数据或凭据；原三服务保持原样。命令只输出PID、端口和connectionFile路径，不输出密钥。重复start复用已核对的进程，不创建新资源；没有操作系统自动启动。

## 最简交互

App → 自定义 → 高级特性 → **DevClaw伙伴**：

1. 导入启动输出中的 `connectionFile`；点击连接服务。主进程分别核对负责人、业务身份和节点身份，凭据加密保存，不返回页面。
2. 选择负责人明确提供的工作区，创建单专家团队（或输入已有单专家Group ID），授权此团队使用指定节点，启用本地节点。当前不读取目录文件，工作区只用于隔离Thread归属。
3. 假招乎页勾选结构化 `@DevClaw伙伴`，发送 `新任务：按日期查询交易，先澄清业务范围`。任务创建不会自动分析。
4. 按返回编号发送 `TASK-编号：仅查询本人有权限的交易`，点击分析需求。
5. 页面展示排队/执行状态和标明“模拟模型返回”的持久结果。没有真实分析、代码可行性判断或正式审批。

节点未启用时先排队等待，不借用其他人执行环境。新任务/澄清/分析分别对应明确操作；没有@的消息不读、不存，不猜最近任务，不依赖回复串。

授权按钮会用已验证的节点凭据登记一次固定模拟能力，但不会开启轮询或执行。服务端沿用60秒心跳过期判定；刚停止或登记后的短暂宽限期可显示排队，随后是waiting_node，实际执行始终必须显式启用App节点。

## 停止与重开

页面“停止节点”停止轮询/心跳并等当前图清理，不假装一点击就终止。只允许取消未领取任务，已运行的用停止节点处理。撤销团队授权仍由服务端当前权限复核。结果未知不自动重跑或迁移。

重开App默认不连接、不启用节点；明确连接后可看到上次执行的持久结果。控制服务stop/start可能更换回环端口，此时重新导入新connectionFile，身份相同则保留App的工作区/团队关联。

```sh
npm run stop:bot-partner
```

stop保留本地控制库、私有凭据和数据卷，不删除数据。原MySQL/ES/S3和定时任务状态不受影响，自动续任务继续PAUSED。

写入请求先保存原command/版本/期限。若回执丢失，只能用完全相同内容重试；页面提示INPUT_CHANGED时不要换新内容盲目重放。跨期限未知写入暂需人工核对，不包含本轮自动协调恢复。

## 验证入口及限制

```sh
npm run test:bot-partner-app
npm run test:bot-partner-panel
npm run demo:bot-partner-http
```

第一个验证安全配置、固定IPC、HTTP客户端/worker和失回执；第二个实际React+Chromium但IPC为测试stub；第三个真实JavaHTTP+隔离MySQL5.7+AppController/worker+SQLite+既有DeepAgent模拟模型往返。不能将它们说成真实招乎或真实模型已接通。生产认证/群绑定适配、真实模型、附件源码、搜索/上传、正式PRD阶段与审批、长期记忆维护、云执行仍在后续范围。
