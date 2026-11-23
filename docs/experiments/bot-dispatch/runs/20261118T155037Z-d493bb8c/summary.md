# Bot 调度实验记录

开始时间：2026-11-18T15:50:37.667Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | independent | independent | false | 17 | 14.4 | 未记录 | passed |
| 复核后等本人批准再发送 | 未记录 | independent | 未记录 | 未记录 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 3.5 | 3.4 | 7 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2 | 2 | 未记录 | passed |
| 日常问答 | inline | inline | false | 1.6 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 11 | 未记录 | 未记录 | passed |

运行错误：result reporting must retain the main Bot tool schemas
