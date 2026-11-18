# Bot 调度实验记录

开始时间：2026-11-18T06:19:39.791Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 3.9 | 3.8 | 2.1 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.3 | 2.3 | 1.7 | 发生错误，见原始记录 |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | independent | independent | false | 1.9 | 1.8 | 未记录 | 发生错误，见原始记录 |
| 日常问答 | inline | inline | false | 1.3 | 未记录 | 未记录 | passed |
| 短文改写 | inline | inline | false | 1.4 | 未记录 | 未记录 | passed |
| 读取一个文件查事实 | inline | inline | false | 3.4 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 5.2 | 未记录 | 未记录 | passed |
| 文件中修改一个时间 | inline | inline | false | 7 | 未记录 | 未记录 | passed |
| 多材料筹备方案及交付 | independent | independent | false | 3.3 | 3.3 | 1.5 | passed |
| 修改既有方案 | continue | continue | false | 11.7 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 1.6 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 4.8 | 未记录 | 未记录 | passed |
| 自然要求后台推进方案 | independent | independent | false | 4.2 | 4.1 | 2.2 | passed |
| 修改既有方案 | continue | continue | false | 13.7 | 未记录 | 未记录 | passed |
| 查进度不重启执行 | inline | inline | false | 2.2 | 未记录 | 未记录 | passed |
| 已完成任务再次修改 | continue | continue | false | 5.6 | 未记录 | 未记录 | passed |
| 跨文件核对数据并输出报告 | independent | independent | false | 7.4 | 7.4 | 1.5 | passed |
| 修复代码并运行验证 | independent | independent | false | 3.5 | 3.5 | 2.4 | passed |
| 从零实现可复用的对账工具 | independent | independent | false | 7.5 | 7.4 | 1.9 | passed |
| 多步分析但用户指定主对话 | inline | inline | false | 8.4 | 未记录 | 未记录 | passed |
| 简单工作但用户要求独立任务 | independent | independent | false | 3.1 | 2.9 | 未记录 | passed |
| 单条耗时命令 | background | background | false | 4 | 未记录 | 未记录 | passed |

运行错误：case failures; inspect JSON report
