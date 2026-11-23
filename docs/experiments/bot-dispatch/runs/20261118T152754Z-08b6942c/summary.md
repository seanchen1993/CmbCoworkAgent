# Bot 调度实验记录

开始时间：2026-11-18T15:27:54.930Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 3.3 | 3.2 | 2.3 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.4 | 2.4 | 未记录 | 发生错误，见原始记录 |
| 日常问答 | inline | inline | false | 1.6 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 4.7 | 未记录 | 未记录 | passed |

运行错误：actual main model request must include routing guidance
