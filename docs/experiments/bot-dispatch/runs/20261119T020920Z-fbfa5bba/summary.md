# Bot 调度实验记录

开始时间：2026-11-19T02:09:20.166Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 主 Bot 复核正式附件后交付 | independent | independent | true | 6.8 | 6.7 | 未记录 | passed |
| 复核后等本人批准再发送 | independent | independent | true | 7.4 | 7.3 | 未记录 | passed |
| 自然要求读取网页，主 Bot 无浏览器工具，任务浏览后回传 | independent | independent | false | 3.6 | 3.6 | 3.1 | passed |
| 材料准备 | inline | inline | false | 3.4 | 未记录 | 未记录 | passed |
| 点名咨询输入 | inline | inline | false | 3.8 | 未记录 | 未记录 | passed |
| 定时需求文档 | independent | independent | false | 4.4 | 4.4 | 未记录 | 发生错误，见原始记录 |
| 借阅需求 | inline | independent | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 借阅规则 | inline | independent | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | inline | independent | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | inline | independent | false | 1.1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 日常问答 | inline | inline | false | 1.1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 短文改写 | inline | inline | false | 0.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 读取一个文件查事实 | inline | inline | false | 0.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 短 Shell 查询 | inline | inline | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 文件中修改一个时间 | inline | inline | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 多材料筹备方案及交付 | inline | independent | false | 0.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 自然要求后台推进方案 | inline | independent | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 跨文件核对数据并输出报告 | inline | independent | false | 3.4 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 修复代码并运行验证 | inline | independent | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 从零实现可复用的对账工具 | inline | independent | false | 0.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 多步分析但用户指定主对话 | inline | inline | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 简单工作但用户要求独立任务 | inline | independent | false | 0.9 | 未记录 | 未记录 | 发生错误，见原始记录 |
| 单条耗时命令 | inline | background | false | 1 | 未记录 | 未记录 | 发生错误，见原始记录 |

运行错误：case failures; inspect JSON report
