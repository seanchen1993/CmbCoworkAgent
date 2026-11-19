# Bot 调度实验记录

开始时间：2026-11-19T12:33:27.002Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然语言排查当日服务异常 | independent | independent | false | 4.3 | 4.3 | 未记录 | passed |
| 同一异常用值班搭档口吻答复 | independent | independent | false | 2.9 | 2.8 | 未记录 | passed |
| 交办后回答另一道独立问题 | independent | independent | false | 6.1 | 4.5 | 未记录 | passed |
| 用户指定格式优先于默认语气 | inline | inline | false | 1.1 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
