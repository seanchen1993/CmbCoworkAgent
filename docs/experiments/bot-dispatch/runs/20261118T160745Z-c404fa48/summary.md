# Bot 调度实验记录

开始时间：2026-11-18T16:07:45.051Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | independent | independent | true | 27.6 | 27.6 | 未记录 | passed |
| 复核后等本人批准再发送 | independent | independent | false | 8.5 | 8.4 | 未记录 | 发生错误，见原始记录 |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 4.4 | 4.3 | 5.5 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.1 | 2.1 | 2.6 | passed |
| 日常问答 | inline | inline | false | 3.5 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 3 | 未记录 | 未记录 | passed |
| 多材料筹备方案及交付 | independent | independent | false | 3.9 | 3.9 | 1.5 | passed |
| 修改既有方案 | continue | continue | false | 3.9 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 2.9 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4.1 | 未记录 | 未记录 | passed |

运行错误：case failures; inspect JSON report
