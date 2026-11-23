# Bot 调度实验记录

开始时间：2026-11-19T03:29:37.394Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 多材料筹备方案及交付 | independent | independent | false | 8.8 | 8.7 | 1.9 | passed |
| 修改既有方案 | continue | continue | false | 3.7 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
