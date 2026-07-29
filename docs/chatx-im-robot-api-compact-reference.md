# 招乎 IM 机器人接口精简参考

> 用途：供后续 Agent、会话和开发者快速了解招乎机器人能力，不替代原始接口文档。
>
> 原始文件：`/Users/heyirui/Downloads/招呼机器人接口.md.md`（4,794 行，274,295 字节）  
> SHA-256：`1db60384673bec6b2778def3fa26da7ceb4027746c89a519fc92b5f94b130386`  
> 整理日期：2026-07-22

## 先读结论

1. 一个机器人可以服务多个用户。上行回调会带用户 `fromId`，下行单聊接口按动态 `toId` 回复；平台并没有“一个机器人只能绑定一个用户”的限制。
2. 官方上行能力是 webhook 或 Kafka 回调，不是 WebSocket。当前 CMBDevClaw 收到的 WS 报文是中转服务自定义协议，不能当作招乎官方协议。
3. 机器人密钥和 Bearer Token 应集中保存在服务端。桌面端无需、也不应保存机器人 `clientSecret`。
4. 用户和群组的主标识分别是用户 OpenID、`groupOpenId`。`groupId` 仍兼容，但文档已不建议使用。
5. 已确认招乎另行提供机器人 Token 获取与刷新接口；本地原始附件未内嵌其字段契约，
   只引用了“招乎令牌服务-开发指南”。OpenID 映射、回调签名、回调超时/重试等也仍需
   在上线前冻结，不能自行猜测。

## 通用约定

- 所有消息发送接口均为 HTTP `POST`，示例使用 `Authorization: Bearer <token>`。
- 单聊公共字段：`fromId` 为机器人 OpenID，`toId` 为接收用户 OpenID。
- 群聊公共字段：`fromId` 为机器人 OpenID，优先使用 `groupOpenId` 标识群组。
- 常规成功响应：`{"code": 0, "msg": "<平台消息ID>"}`。更新或撤回成功时 `msg` 通常为 `0`。
- HTTP 200 不等于业务成功，仍需检查 JSON 中的 `code`。
- 发送成功返回的平台消息 ID 要持久化；撤回、更新审批、更新卡片均依赖它。
- 文本上限为 3,000 字符。文件上传上限小于 1 GiB；卡片内图片通常要求小于 1 MiB。

### 幂等

消息发送请求可携带头：

```http
ROBOT-MESSAGE-ID: <调用方生成的唯一 UUID>
```

- 平台保存该 UUID 10 分钟。
- 同一业务发送的失败重试必须复用同一个 UUID。
- 不同消息必须使用不同 UUID。
- 10 分钟外的重复语义、超时后的最终状态查询，原文没有给出，需要业务侧另做状态记录和人工兜底。

### 常见错误

| HTTP / code | 含义         | 处理建议                    |
| ----------- | ------------ | --------------------------- |
| `200 / 0`   | 成功         | 记录 `msg` 消息 ID          |
| `200 / 120` | 消息发送失败 | 检查接收方 OpenID           |
| `400`       | 参数错误     | 校验请求结构和必填字段      |
| `401`       | Token 无效   | 刷新或重新获取 Token        |
| `403`       | 无接口权限   | 检查机器人资源授权          |
| `404`       | 路径错误     | 检查环境基址和 URI          |
| `429`       | 网关限流     | 指数退避；重试时复用幂等 ID |

## 下行单聊能力

| 能力           | URI                                                | 关键说明                                                                 |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------ |
| 文本           | `/robot-service/single-message/text`               | `content` 或 `base64Content`，最多 3,000 字符                            |
| 图片           | `/robot-service/single-message/image`              | 先上传图片，再传图片 ID、大小及行内/行外链接                             |
| 多图文         | `/robot-service/single-message/multi-image-text`   | 多单元、可跳转，点击可产生回执                                           |
| 转发图文       | `/robot-service/single-message/image-text`         | 标题、摘要、跳转链接，可带缩略图                                         |
| 分享           | `/robot-service/single-message/share`              | 标题、摘要、来源、链接和配图                                             |
| 文件           | `/robot-service/single-message/file`               | 先上传文件；招乎 APP/PC 支持                                             |
| 审批通知       | `/robot-service/single-message/send-audit`         | 卡片状态 0～6，可后续更新                                                |
| 审批通知 2.0   | `/robot-service/single-message/send-audit-beta`    | 同意/拒绝按钮会产生上行回执                                              |
| 更新审批       | `/robot-service/single-message/update-audit`       | 按原 `msgId` 更新，不产生新消息                                          |
| 通知卡片       | `/robot-service/single-message/notify`             | 标题、图、富文本、最多 3 个反馈操作和 3 个底部链接                       |
| 撤回           | `/robot-service/single-message/undo-message`       | 按平台 `msgId` 撤回，时限 24 小时                                        |
| 模板/富文本    | `/robot-service/single-message/template`           | `templateId` 1001～1999 为模板，12 为富文本，15 为评价；终端兼容性不一致 |
| 自定义卡片     | `/robot-service/single-message/custom-card`        | 招乎 APP/PC V6.6+；组件化、交互、Markdown、图表、AI 内容                 |
| 更新自定义卡片 | `/robot-service/single-message/update-custom-card` | 用新 `content` 覆盖原卡片                                                |
| 旧卡片         | `/robot-service/single-message/url`                | 已废弃，不应新增接入                                                     |
| 名片           | `/robot-service/single-message/card`               | 试用/内部能力，不建议作为通用功能依赖                                    |

### 批量单聊

多数单聊发送接口支持把 `toId` 替换为 `toIdList`：

```json
{
  "fromId": "<robot-open-id>",
  "toIdList": ["<user-a-open-id>", "<user-b-open-id>"],
  "content": "通知内容"
}
```

- `toId` 和 `toIdList` 同时存在时，只按 `toId` 发送。
- 响应通过 `successMap` 和 `failedMap` 表达逐用户结果。
- 批量能力适合系统通知，不适合机器人对话回复；对话回复应只发给当前上行消息的发送人。

## 下行群聊能力

| 能力              | URI                                                         | 关键说明                                |
| ----------------- | ----------------------------------------------------------- | --------------------------------------- |
| 文本              | `/robot-service/group-message/text`                         | 最多 3,000 字符                         |
| 图片              | `/robot-service/group-message/image`                        | 先上传图片                              |
| 多图文            | `/robot-service/group-message/multi-image-text`             | 多单元、点击回执                        |
| 转发图文          | `/robot-service/group-message/image-text`                   | 标题、摘要、链接                        |
| 分享              | `/robot-service/group-message/share`                        | 分享卡片                                |
| 文件              | `/robot-service/group-message/file`                         | 招乎 APP/PC 支持                        |
| 群 @              | `/robot-service/group-message/at`                           | `toId` 可用逗号分隔多人；不支持 @所有人 |
| 撤回              | `/robot-service/group-message/undo-message`                 | 24 小时内按 `msgId` 撤回                |
| 模板/富文本       | `/robot-service/group-message/template`                     | 与单聊模板能力类似                      |
| 自定义卡片        | `/robot-service/group-message/custom-card`                  | V6.6+；V6.8+ 支持 `atIds` 和千人千面    |
| 更新公共卡片      | `/robot-service/group-message/update-custom-card`           | 覆盖群内原卡片公共内容                  |
| 增量/千人千面更新 | `/robot-service/group-message/increment-update-custom-card` | V6.8+；公共和个人组件按递增版本更新     |
| 旧卡片            | `/robot-service/group-message/url`                          | 已废弃                                  |
| 名片              | `/robot-service/group-message/card`                         | 试用/内部能力                           |

## 上传资源

### 图片

`POST /robot-service/upload/image`，`multipart/form-data` 的 `file` 字段。

返回：

- `imageId`、`imageSize`
- `thumbId`、`thumbSize`
- `imageBeanUrl.originPresignedUrl`：原图行内链接
- `imageBeanUrl.originGwUrl`：原图行外链接
- `imageBeanUrl.originDirectUrl`：浏览器直链
- 对应的 `scaled*` 缩略图链接

### 文件

`POST /robot-service/upload/file`，字段为 `file` 和上传人 `fromId`，文件小于 1 GiB。

返回 `fileId`、`fileSize`、`bucketName`，以及 `fileBeanUrl.presignedUrl/gateWayUrl`。

## 上行回调

机器人后台可配置 webhook 或 Kafka。用户给机器人发送消息、或在群里 @机器人后，平台把消息回调到该地址。

生产回调源网段在原文中列为：

- `12.6.72.0/21`
- `12.6.112.0/21`

接收端需要提前开通网络，并在入口层做来源网段限制。原文没有定义消息签名，所以不能只凭请求体相信发送者身份。

### 普通消息字段

| 字段                                    | 说明                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `msgId`                                 | 平台消息唯一 ID，应用侧去重主键                           |
| `msgType`                               | `text`、`at`、`custom`、`image`、`voice`、`reference` 等  |
| `timestamp`                             | 消息时间戳                                                |
| `fromId`                                | 实际发送人的用户 OpenID                                   |
| `toId`                                  | 接收方/被 @ 机器人 OpenID                                 |
| `groupId` / `groupOpenId` / `groupName` | 群消息上下文；两种群 ID 都为空时为单聊                    |
| `msgContent`                            | 文本或群 @ 内容                                           |
| `imageInfo`                             | 原图/缩略图的行内、行外链接                               |
| `voiceInfo`                             | 语音文件链接、`asrCode` 和可选 `asrText`                  |
| `referenceInfo`                         | 被引用消息，可包含文本、图、语音、合并转发；最多嵌套 4 层 |
| `netWorkStatus`                         | 0 未知、1 办公网、2 互联网、3 业务网                      |
| `deviceId` / `clientType`               | 设备标识和 `pc/ios/android/pad`                           |
| `skillCode`                             | V6.15+ 单聊快捷短语技能标识                               |

建议的对话归一化规则：

- 单聊会话：发送人 `fromId` + 机器人 `toId`。
- 群聊会话：`groupOpenId` + 发送人 `fromId`；回复目标为 `groupOpenId`，必要时 @原发送人。
- 文本载荷：`msgContent`，不是当前客户端中转协议里的 `content`。
- 不要把请求 URL 上的 IP 当作用户身份；身份应由 `fromId` 与企业登录身份的权威映射确定。

### 事件类回调

| `msgType`           | 说明                                      |
| ------------------- | ----------------------------------------- |
| `readNotify`        | 用户已读通知；`msgContent` 是 JSON 字符串 |
| `entrySession`      | 用户进入机器人单聊；同终端 5 分钟最多一次 |
| `updateAudit`       | 审批 2.0 点击回执                         |
| `NotifyReply`       | 通知卡片反馈回执                          |
| `FullTextReply`     | 富文本操作回执                            |
| `ImageTextNotify`   | 多图文点击回执                            |
| `CustomCard`        | 自定义卡片按钮/表单回执                   |
| `robotSkillOperate` | V6.15+ 快捷短语技能开关回执               |

其中 `readNotify`、`entrySession` 和各类回执的 `msgContent` 常以“JSON 字符串”而非 JSON 对象返回，接入层需要二次解析并做好异常保护。

## 自定义卡片能力摘要

自定义卡片是最适合后续增强 AI 体验的一组接口：

- 单聊 `content` 总长度不大于 15,000 字符。
- 群卡片公共 `content` 不大于 15,000 字符，千人千面 `personal` 不大于 10,000 字符，组件最多 30 个。
- 基础组件：来源、卡片类型、标题、状态、正文、键值对、图片、分割线。
- 操作组件：横向/纵向/互斥/组合按钮，支持跳转、回执、客户端交互。
- 布局组件：横向容器、普通容器。
- 数据组件：表格、饼图、环形图、折线图、柱状图。
- 表单组件：输入框、列表选择器、时间选择器和提交按钮。
- `mdContainer`：V6.14+ 静态 Markdown，不支持 HTML。
- `aiContent`：V6.15+ AI 文本/Markdown，可展示思考区域；直接发送没有流式效果。
- 原卡片可按 `msgId` 更新；群千人千面组件用递增 `version` 控制更新。
- 真正的 AI 流式卡片需要另一份《招乎自定义卡片消息流式输出对接指南》，当前原始文件只给出链接，没有协议内容。

## 对 CMBDevClaw 最有价值的能力分层

### 首版必用

- 上行单聊文本：`msgId/fromId/toId/msgContent`
- 下行单聊文本：动态 `toId`
- `ROBOT-MESSAGE-ID` 幂等头
- 平台返回消息 ID 的持久化
- 429、超时、部分失败处理

### 下一阶段

- 群 @ 上行和群 @ 下行
- 图片上行、语音 ASR、引用消息
- 自定义卡片“处理中 → 完成/失败”更新
- 文件和图片回传
- 已读、进入会话和按钮回执

### 暂缓

- 已废弃 `/url` 卡片
- 试用名片能力
- 千人千面群卡片
- AI 流式卡片（获取完整流式协议后再做）

## 本地附件未闭合、上线前必须确认

1. 机器人 Bearer Token 获取/刷新接口已确认存在；仍需归档正式 URI、认证参数、返回字段、
   过期时间、refresh token 是否轮换、并发刷新规则和错误码。
2. 企业账号（当前客户端已有 `sapId/ystId`）到招乎用户 OpenID 的权威转换接口。
3. webhook 的期望成功响应、超时、重试次数、顺序保证和是否存在签名头。
4. Kafka 模式的 Topic、认证、分区键、消费确认和重投策略。
5. 单接口 QPS、机器人级配额、批量 `toIdList` 最大人数。
6. 消息/附件保留期及行内、行外 URL 有效期。
7. 自定义卡片客户端版本探测方式，以及不支持时的降级行为。
8. AI 自定义卡片流式输出的完整协议。
9. OpenID、消息内容、附件和审计日志的数据分级与保留要求。
