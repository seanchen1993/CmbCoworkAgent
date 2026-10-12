# 本地需求分析闭环

这是R01-A6的可重复开发演示，不是已接通招乎的产品入口。使用实际Java应用控制、隔离MySQL5.7、App SQLite专用Thread/attempt日志和现有DeepAgent图；模型固定为本地假模型，不调用付费或真实推理服务。

## 最小旅程

业务创建Task → 按TASK编号提交澄清 → 开发负责人指定本地节点/只读授权 → 节点认证领取 → 启动前当前权限与冻结版本重验 → 专用Thread分析本任务文本 → 持久结果 → 重复请求/重开只读回同一结果，不再次调用模型。

任务澄清只包含当前Task、未超出冻结版本、未指定其他专家的显式文本。最多50条，总文本和App编码输入均有上限；超限拒绝，不静默截断。专家配置是固定BotVersion，不能提升工具权限。本阶段无文件/命令/技能/Hook/MCP/子代理/个人记忆，没有整群历史或个人Thread历史。

## 运行

工作树：`/Users/heyirui/.codex/worktrees/devclaw-bot-integration/cmbCowork`。需要现有任务专用Docker/Colima在线和JDK8依赖缓存；不要切用户默认Docker context，不使用prune。

```sh
node deploy/dev/service/build.mjs
npm run test:bot-execution
npm run demo:bot-requirement
```

开发验证使用Node22（本机已缓存路径 `/Users/heyirui/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`），可将该目录临时放入本命令PATH。JDK8构建器有明确路径/环境审计。演示仅建立任务专用临时数据库和SQLite目录，在finally精确回收；原MySQL/ES/S3及其数据保留，秘密仅经验证的私有stdin进入测试JVM。

最后一行验证摘要应包含 `existingDeepAgent:true`、`fakeModel:true`、`modelCalls:1`、`tools:0`、`mysqlResultPersisted:true`、`sqliteReopen:true`、`identicalSettlementReplay:true`。重复执行演示会创建新隔离fixture，不代表同一线上业务任务被重新执行。假模型输出用于验证链路，不能评价真实需求分析质量。

## 已定义的边界

Java认证adapter的start/renew/settle/getResult与App执行器解耦；测试管道只是固定fixture运输，不是生产HTTP/WSS认证方案。App启动仅注册受限执行profile，没有自动领取、模型调用或真实群监听。没有负责人授权UI、招乎群绑定、真实机器人收发、附件读取、正式PRD/审批/阶段流转、云Runtime或unknown人工协调恢复。

30秒租约以当前授权续期；续租失败/过期则Abort，不能把迟到输出标成功。图完成后释放本地互斥，底层provider取消仍依赖AbortSignal支持；没有工具副作用的exactly-once承诺。reserved/running在重开后保留为结果未知，不自动重执行。已生成结果先本地持久化，再提交服务器，失回执只重交同结果；服务器当前读取授权和凭据失效检查仍适用。
