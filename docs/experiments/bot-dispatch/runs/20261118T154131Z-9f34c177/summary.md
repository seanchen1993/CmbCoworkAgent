# Bot 调度实验记录

开始时间：2026-11-18T15:41:31.494Z；状态：failed；模型：deepseek-v4-flash。
阶段：case:delivery-review。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | 未记录 | independent | 未记录 | 未记录 | 未记录 | 未记录 | 发生错误，见原始记录 |

运行错误：page.evaluate: Error: Error invoking remote method 'bots:work:list': BotError: Bot 状态未能可靠保存，已暂停新任务；请检查本机存储后重启应用
