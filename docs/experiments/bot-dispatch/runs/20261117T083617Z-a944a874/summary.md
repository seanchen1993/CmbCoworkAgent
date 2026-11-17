# Bot 调度实验记录

开始时间：2026-11-17T08:36:17.253Z；状态：failed；模型：deepseek-v4-flash。
阶段：verify:slash-skill-natural。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 11.1 | 11 | 未记录 | passed |

运行错误：Real-model case did not settle within six minutes
