# 现有真实模型与本地完整流程验证

2026-10-19，用户明确要求使用现有模型、配置专家并完整测试交办、退回修改、确认。root设计和独立验收，沿用gpt-6.1-sol/xhigh实施代码。当前集成提交`c1cc9c5d4f71c8945728555a07265d8753b24f60`，未推送。

## 配置与启动

仅复用用户现有`custom:cheap / deepseek-v4-flash`，provider为`https://api.deepseek.com`，保持已有模型参数。源`~/.cmbcoworkagent`不修改；仅将该模型及对应凭据写入独立preview-app/data的custom-models.json和.env，文件权限0600，不复制其他模型或私人历史，不记录秘密。没有添加新供应商。

通过实际App创建“需求交付专家”，职责为中文需求说明、业务规则、验收要点、区分事实与假设，并依据上一版和退回意见修订。实际原生确认后启用本机24小时；服务会话明确选择该真实模型，执行仅使用提供的文字，无源码/文件工具。旧设置面板“模拟模型”描述属于开发演示入口，本次使用Bots工作区的服务会话。

首次启用受预览启动器Playwright自动dismiss原生confirm影响。sol修复`9e451c66`仅为firstWindow添加不处理dialog的监听，page关闭后清理，不调用accept/dismiss、不改变生产授权。root独立9/9，sol19/19；正常合并`c1cc9c5d`并用项目stop/start重启后，CUA原生OK真正使本机已启用。此实际验证覆盖确定路径；未重复声明本轮执行取消路径。历史Node25引导Ctrl+C问题仍独立保留。

## 实际流程与证据

使用虚构内部图书借阅需求，不含真实业务数据。全程原生CUA操作App，实际Java/MySQL、SQLite、worker及Runtime访问现有DeepSeek服务。

| 操作 | 实际结果 |
| --- | --- |
| 交办TASK-1 | v1包含30天、最多5本、归还后再借、逾期仅提醒不罚款；待确认 |
| 提出修改并保存 | 要求14天、最多3本并保留其他规则，同任务产生第二次Run |
| v2返回 | 正文与验收点同步为14天/3本，保留归还后再借、不罚款并列出本轮修改 |
| 确认完成 | UI显示已确认完成；服务端Task completed/version5，成果head v2 completed，canReview=false |
| 查看v1 | 保留30天/5本原文及退回意见，历史版本只读 |
| 交办新任务 | 回到空白输入页，真实模型仍已选、本机已启用，已完成示例在右侧保留 |

Task ID `2d1c8385-74ae-4de6-a1b1-9a092767f6f2`；Run v1 `9af65d09-ebda-4bf6-b2ec-aacd62f765ee`，v2 `287d29fd-eaf1-4e33-adb2-5c675418895d`。SQLite两个请求均terminal/succeeded、绑定custom:cheap；publish/reject/publish/approve四个动作均done。通过现有business身份只读调用deliverySummaries/Versions再次核对服务端完成事实与[2,1]两个版本，nextBefore=null。

main.log记录08:39:25Z及08:41:05Z两次指定DeepSeek模型请求均HTTP200，确认后无第三次模型请求。684ms/552ms仅为响应头时间，不作为完整推理耗时或性能基准。最小无密钥证据保存在`/tmp/m03-real-model-evidence.json`。

观察到的内容质量限制：模型对80字展示标题的截断作了多余解释；第二版也未严格保持最初300字以内的要求。核心规则修订正确，不把这一小样本宣称为模型质量全面验收。没有ES查询或生产性能改动。

## 留给用户的运行状态

Node22绝对预览脚本启动，session50615/supervisor27333，App27558，Java27495/127.0.0.1:61613，Partner MySQL healthy，数据保留。启动日志`/tmp/m03-real-model-preview-fixed-start.log`。最新Java沿用本次启动前71JUnit/1884parity通过的构建，App在预览修复合入后重新完整构建。

保持应用、Java及Partner库运行，用户从“Bots工作区→需求交付专家”直接交办。随后点击“提出修改→保存意见并修改”，新版本返回后“确认完成”。重启应用不承诺自动启用本机。停止使用集成树`npm run stop:bot-preview`；不依赖仍未验收的Node25引导Ctrl+C。

原B00 MySQL保持停止，原ES/S3未操作；未推送、部署、恢复定时或访问企业内网。此记录补充此前全部fake的M03验收，证明本次单专家文本真实模型闭环，不扩展为真实招乎、多专家、文件执行或生产验收。
