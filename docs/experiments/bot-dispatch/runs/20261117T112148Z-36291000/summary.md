# Bot 调度实验记录

开始时间：2026-11-17T11:21:48.735Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | inline | independent | false | 1.5 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | inline | independent | false | 1.2 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 日常问答 | inline | inline | false | 2.6 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 3.8 | 未记录 | 未记录 | passed |

运行错误：case failures; inspect JSON report
