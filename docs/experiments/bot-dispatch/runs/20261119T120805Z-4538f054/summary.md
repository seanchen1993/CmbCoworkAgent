# Bot 调度实验记录

开始时间：2026-11-19T12:08:05.978Z；状态：passed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然语言排查当日服务异常 | independent | independent | false | 3.4 | 3.3 | 未记录 | passed |
| 日志汇报保留错误码、原因和建议 | independent | independent | false | 5.2 | 5.2 | 未记录 | passed |
| 证据不足时说明还缺哪条记录 | independent | independent | false | 7.2 | 7.1 | 未记录 | passed |
| 用户询问方法时给出实际工具名 | independent | independent | false | 3.6 | 3.6 | 未记录 | passed |
| 点名咨询输入 | inline | inline | false | 3.6 | 未记录 | 未记录 | passed |
| 日常问答 | inline | inline | false | 1.5 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 7.5 | 未记录 | 未记录 | passed |

路线偏好与业务校验分别记录。running 表示尚未结算，进程中断留下的记录不能当成通过。
