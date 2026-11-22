# Bot 调度实验记录

开始时间：2026-11-19T11:33:47.831Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然语言排查当日服务异常 | independent | independent | false | 5.7 | 5.7 | 未记录 | 发生错误，见原始记录 |
| 点名咨询输入 | inline | inline | false | 4.1 | 未记录 | 未记录 | passed |
| 日常问答 | inline | inline | false | 2.7 | 未记录 | 未记录 | passed |
| 短 Shell 查询 | inline | inline | false | 3.8 | 未记录 | 未记录 | passed |

运行错误：case failures; inspect JSON report
