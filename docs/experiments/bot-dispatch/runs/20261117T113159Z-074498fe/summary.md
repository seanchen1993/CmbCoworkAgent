# Bot 调度实验记录

开始时间：2026-11-17T11:31:59.804Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 3.3 | 3.3 | 1.4 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
