# Bot 调度实验记录

开始时间：2026-11-19T10:24:19.544Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 日志汇报保留错误码、原因和建议 | independent | independent | false | 8.3 | 5.6 | 未记录 | passed |
| 证据不足时说明还缺哪条记录 | independent | independent | false | 6.9 | 4.3 | 未记录 | passed |
| 用户询问方法时给出实际工具名 | independent | independent | false | 3.3 | 3.2 | 未记录 | passed |
| 主 Bot 复核正式附件后交付 | independent | independent | true | 13.4 | 13.3 | 未记录 | passed |
| 复核后等本人批准再发送 | independent | independent | true | 7.2 | 7.1 | 未记录 | passed |

运行错误：result reporting must retain the main Bot tool schemas
