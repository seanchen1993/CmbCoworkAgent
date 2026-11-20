# Bot 调度实验记录

开始时间：2026-11-19T12:22:17.160Z；状态：failed；模型：deepseek-v4-flash。
阶段：suite:request-contracts。完整输入、回复、版本及错误见 [record.json](record.json)。

| 案例 | 实际路线 | 期望路线 | 预算兜底 | 主轮秒 | 交办秒 | 后台中回复秒 | 校验 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 自然语言排查当日服务异常 | independent | independent | false | 4.1 | 4 | 未记录 | passed |
| 用户询问方法时给出实际工具名 | independent | independent | false | 4.3 | 4.2 | 未记录 | passed |
| 仅斜杠选技能，不要求独立任务，观察实际读取与交办顺序 | independent | independent | false | 2.3 | 2.5 | 未记录 | passed |
| 同一异常用值班搭档口吻答复 | independent | independent | false | 4.1 | 4.1 | 未记录 | 发生错误，见原始记录 |
| 用户指定格式优先于默认语气 | inline | inline | false | 1.7 | 未记录 | 未记录 | passed |

运行错误：case failures; inspect JSON report
