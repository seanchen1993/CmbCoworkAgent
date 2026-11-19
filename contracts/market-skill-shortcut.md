# 应用市场会话导航接口

Electron 主进程在现有 `VITE_API_BASE_URL` 下访问
`/api/trajectories/marketplace/conversation-shortcuts/project-plugin-creation`。
所有请求携带 `Authorization: Bearer <ystAccessToken>`。由市场服务验证企业登录凭证，
从凭证识别账号，并使用服务端管理员授权。发布前需和市场服务确认 token audience。

| 方法 | 接口行为 |
| --- | --- |
| GET | 返回该账号当前可见的独立技能及管理权限。 |
| PUT | 仅管理员可调用。请求 `{ "itemId": "market-id", "revision": "v1" }`。空 `itemId` 撤标。服务端校验条目属于已上架的普通技能，核对修订号并原子更新唯一绑定，记录变更前后目标和操作人。返回新绑定。 |
| GET /installation?itemId=…&revision=… | 原子校验当前绑定、账号可见性和修订号，按条目 ID 返回该技能原始安装包。响应设置 `X-Skill-Package-Format: zip` 或 `md`。包体上限 32 MiB。 |

正常读取和保存响应示例

```json
{
  "revision": "v1",
  "canManage": true,
  "assignedItemId": "market-id",
  "target": {
    "itemId": "market-id",
    "name": "项目模式插件开发助手",
    "description": "设计和打包项目模式插件。",
    "skillName": "project-plugin-author"
  }
}
```

`skillName` 为当前包根 `SKILL.md` frontmatter 的精确名称，允许与市场展示名不同。
无绑定、撤标、下架或当前账号不可见时返回 `200` 和 `target: null`。管理员可通过
`assignedItemId` 看到仍存在的绑定，普通账号此字段返回 `null`。
绑定和包根技能身份发生变化时更新修订号。过期修订号或安装目标已变化返回
`409` 或 `412`，身份校验失败返回 `401` 或 `403`。所有结果都按账号隔离，禁止共享缓存。
