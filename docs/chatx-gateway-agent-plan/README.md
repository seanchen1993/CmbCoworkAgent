# ChatX Java 网关分阶段交付说明

> 这份文件只给项目负责人看，不需要交给代码 Agent。

## 你到底要给 Agent 什么

第一次实施阶段一时，只给三样东西：

1. Java 网关代码仓库；
2. [阶段一任务单](./01-contract-freeze.md)；
3. 你补充的两份正式资料：**Token 获取接口文档**、**Token 刷新接口文档**。

阶段一会把这两份 Token 文档转换成仓库内的固定契约和测试 fixture。完成阶段一后，后续每次只需
给 Agent：

1. 同一个 Java 网关代码仓库；
2. 当前一个阶段任务单。

不需要再给 Agent 以下材料：

- 4,794 行的《招呼机器人接口》原文；
- `chatx-im-robot-api-compact-reference.md`；
- Java 网关母规格；
- 本 README；
- webhook、单聊文本发送、错误码或幂等规则的其他附件。

上述招乎接口已经直接写进阶段一、阶段四和阶段五任务单。WSS 字段、数据库表和安全规则也会写在
对应任务单中，Agent 不需要自行拼接多份设计稿。

## 按这个顺序交付

| 次序 | 直接交给 Agent 的任务单                             | 完成结果                                             |
| ---- | --------------------------------------------------- | ---------------------------------------------------- |
| 1    | [阶段一：契约与 Mock](./01-contract-freeze.md)      | 固定所有协议；此时一次性附上 Token 获取、刷新文档    |
| 2    | [阶段二：工程与数据库](./02-foundation-database.md) | Java 工程、MySQL 5.7、MyBatis 和基础 Repository 可用 |
| 3    | [阶段三：身份与连接](./03-identity-websocket.md)    | `ystIdToken` 可认证，Desktop WSS 可稳定连接          |
| 4    | [阶段四：消息入站](./04-inbound-execution.md)       | 招乎单聊文本可可靠到达 Desktop 并取得执行许可        |
| 5    | [阶段五：回复闭环](./05-reply-closed-loop.md)       | Desktop 回复可通过招乎机器人发回用户                 |
| 6    | [阶段六：生产加固](./06-production-hardening.md)    | 多实例、恢复、监控和故障演练达到上线条件             |

阶段五完成后可以进行内网端到端试用；阶段六完成前不应正式上线。

## 每次复制给 Agent 的一句话

```text
请只实施随附任务单中的当前阶段。先检查仓库 HEAD 和现有改动，再按任务单顺序完成代码、数据库迁移和测试；不要提前实现下一阶段。完成后列出改动文件、测试结果、未完成项和最终 commit。
```

## 固定技术边界

- JDK 1.8、内部增强版 Spring Boot 2.7.2、Maven；
- MySQL 5.7、MyBatis Mapper + XML；
- 一个官方机器人服务所有用户；
- 每个企业用户只有一个活动 Desktop 连接，后连接替代先连接；
- 不实现设备列表、设备选择、`deviceEpoch` 或物理设备路由；
- 网关不理解 Project、Feature、Thread 或 workspace path，只做身份、可靠传输和执行许可；
- `ystIdToken` 只用于 Desktop 登录，招乎机器人 Token 只用于平台下行，两者绝不能混用。

## 招乎接口来源说明

任务单内嵌的招乎 webhook、单聊文本、幂等和错误码来自已提供的
`/Users/heyirui/Downloads/招呼机器人接口.md.md`。原文没有 Token 获取/刷新字段，所以只有这两份
资料仍需你补充一次。
