# Bot 调度实验记录

开始时间：2026-11-18T06:31:10.620Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.8 | 2.7 | 1.3 | 发生错误，见原始记录 |
| 主 Bot 斜杠技能选择、独立任务激活及文件回传 | independent | independent | false | 2.2 | 2.1 | 未记录 | 发生错误，见原始记录 |
| 修复代码并运行验证 | independent | independent | false | 3.2 | 3.2 | 2.1 | passed |
| 从零实现可复用的对账工具 | independent | independent | false | 5.6 | 5.5 | 1.7 | passed |

运行错误：case failures; inspect JSON report
