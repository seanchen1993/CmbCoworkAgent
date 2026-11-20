# Bot 调度实验记录

开始时间：2026-11-19T12:29:18.280Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 定时需求文档 | independent | independent | false | 5.5 | 5.5 | 未记录 | passed |
| 借阅需求 | independent | independent | false | 4.1 | 4.1 | 未记录 | passed |
| 文字点名修改原 PRD | continue | continue | false | 2.9 | 未记录 | 未记录 | passed |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | independent | independent | false | 2.4 | 2.3 | 未记录 | passed |
| 不再选择技能，继续原任务修改并回传 | continue | continue | false | 5.2 | 未记录 | 未记录 | passed |
| 再次选择技能，恢复已完成的原任务而非新建 | continue | continue | false | 1.8 | 未记录 | 未记录 | passed |
| 日常问答 | inline | inline | false | 1.5 | 未记录 | 未记录 | passed |
| 多材料筹备方案及交付 | independent | independent | false | 3.4 | 3.4 | 3 | passed |
| 修改既有方案 | continue | continue | false | 2.7 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 1.7 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4.4 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
