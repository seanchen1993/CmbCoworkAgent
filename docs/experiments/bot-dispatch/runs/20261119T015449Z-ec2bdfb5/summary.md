# Bot 调度实验记录

开始时间：2026-11-19T01:54:49.707Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | independent | independent | false | 8.8 | 6.2 | 未记录 | passed |
| 复核后等本人批准再发送 | independent | independent | true | 8.1 | 8.1 | 未记录 | passed |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 4.7 | 4.7 | 2.1 | passed |
| 材料准备 | inline | inline | false | 3.9 | 未记录 | 未记录 | passed |
| 点名咨询输入 | inline | inline | false | 4.3 | 未记录 | 未记录 | passed |
| 定时需求文档 | independent | independent | false | 4.1 | 4 | 未记录 | passed |
| 借阅需求 | independent | independent | false | 4.2 | 4.1 | 未记录 | passed |
| 文字点名修改原 PRD | continue | continue | false | 3.3 | 未记录 | 未记录 | observed |
| 借阅需求 | 未记录 | 未记录 | 未记录 | 未记录 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 借阅规则 | independent | independent | false | 7.6 | 7.5 | 未记录 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.2 | 2.2 | 1.1 | passed |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | independent | independent | false | 2.4 | 2.4 | 未记录 | passed |
| 不再选择技能，继续原任务修改并回传 | continue | continue | false | 4.7 | 未记录 | 未记录 | passed |
| 再次选择技能，恢复已完成的原任务而非新建 | continue | continue | false | 1.9 | 未记录 | 未记录 | passed |
| 日常问答 | inline | inline | false | 2.3 | 未记录 | 未记录 | passed |
| 短文改写 | inline | inline | false | 1.8 | 未记录 | 未记录 | passed |
| 读取一个文件查事实 | inline | inline | false | 3.7 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 5.6 | 未记录 | 未记录 | passed |
| 文件中修改一个时间 | inline | inline | false | 7.6 | 未记录 | 未记录 | passed |
| 多材料筹备方案及交付 | independent | independent | false | 4.3 | 4.3 | 2.2 | passed |
| 修改既有方案 | continue | continue | false | 4.3 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 4.6 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4.5 | 未记录 | 未记录 | passed |
| 自然要求后台推进方案 | independent | independent | false | 7 | 6.8 | 3.2 | passed |
| 修改既有方案 | continue | continue | false | 4.1 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 8.3 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4 | 未记录 | 未记录 | passed |
| 跨文件核对数据并输出报告 | independent | independent | false | 6.8 | 6.7 | 6.1 | passed |
| 修复代码并运行验证 | independent | independent | true | 12.1 | 12 | 1.9 | passed |
| 从零实现可复用的对账工具 | independent | independent | false | 7.4 | 7.3 | 2.4 | 发生错误，见原始记录 |
| 多步分析但用户指定主对话 | inline | inline | false | 1.2 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 简单工作但用户要求独立任务 | inline | independent | false | 1.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 单条耗时命令 | inline | background | false | 1.5 | 未记录 | 未记录 | 发生错误，见原始记录 |

运行错误：case failures; inspect JSON report
