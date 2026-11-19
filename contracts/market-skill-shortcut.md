# 应用市场会话导航

现有普通技能条目的 `extra_json.conversationShortcut` 存储导航标记，值为
`"project-plugin-creation"`。撤标删除该键。沿用市场已有的技能记录和三个接口路径，
无需新增数据库字段、配置表或 API 路径。

客户端主进程在现有 `VITE_API_BASE_URL` 下请求
`/api/trajectories/marketplace`，使用现有 `ystAccessToken` 作为 Bearer 凭证。
下面的行为仅在请求带有 `conversationShortcut=project-plugin-creation` 时启用。
发布前确认市场服务可验证该凭证的 audience。

## 最小服务端改动

1. **列表 `GET /list/skill`**

   针对导航查询，按当前账号和上架、灰度规则返回 `items`，内容为零或一条带标记的技能，
   并附上 `shortcut` 元数据。元数据含 `slot`、`revision`、`canManage` 和
   `assignedItemId`。只有管理员获得实际的 `assignedItemId`，即使该目标现在不可见。
   普通账号和无绑定时该字段返回 `null`。查询直接取当前标记，避免受常规市场列表截断影响。
   导航响应总大小上限 16 KiB，`extra_json` 可只投影导航标记。
2. **更新 `PUT /skill/{name}`**

   沿用 multipart。导航模式接收 `resource_type=skill`、`name`、`item_id`、
   `shortcut_revision` 及 `extra_json`。后端验证企业登录凭证和管理员权限，
   验证名称和稳定 ID 属于同一个条目，并检查修订号。只合并 `extra_json.conversationShortcut`
   这个键。一个事务内移除旧条目的标记并给新条目打标，撤标要求提交当前条目 ID，
   上传与普通编辑路径共用保留字段校验，保留库中已有标记并忽略请求中的导航标记。
   因此旧客户端编辑描述、灰度或发版刷新 `extra_json` 时也会保留标记。
   写入成功返回 2xx 即可，客户端再用列表查询读取真实结果。
3. **下载 `GET /download/skill/{name}`**

   导航模式增加 `itemId` 和 `shortcutRevision` 两个查询参数。下载处理器校验该账号对当前
   标记可见，确保名称、ID、修订号和实际下载资源一致。响应沿用现有文件流和
   `Content-Disposition`，附加 `X-Marketplace-Item-Id` 用于确认本次受校验的条目。
   包体上限为 32 MiB。普通下载调用保持原有协议。

`revision` 应覆盖当前绑定和关联的包版本，撤标或换绑后更新。可由现有记录的版本推导，
包括无绑定时的可比较值。服务端需要串行化同一导航位上的更新，然后在同一事务中比较修订号
和改写标记。过期修订号或安装目标已变化返回 409 或 412。身份校验失败返回 401 或 403。
导航查询结果按账号隔离，禁止共享缓存。旧市场若缺少 `shortcut` 元数据，客户端隐藏入口
和打标按钮，并拒绝发送导航写入请求。

## 载荷示例

管理员打标时的 multipart `extra_json`

```json
{ "conversationShortcut": "project-plugin-creation" }
```

管理员撤标时该键在请求中为 `null`，服务端据此删除保存的键。

导航列表响应

```json
{
  "type": "skill",
  "items": [
    {
      "id": "market-id",
      "name": "project-plugin-author",
      "chinese_name": "项目模式插件开发助手",
      "description": "设计和打包项目模式插件。",
      "filename": "project-plugin-author.zip",
      "extra_json": "{\"conversationShortcut\":\"project-plugin-creation\"}"
    }
  ],
  "shortcut": {
    "slot": "project-plugin-creation",
    "revision": "v1",
    "canManage": true,
    "assignedItemId": "market-id"
  }
}
```

现有市场 `name` 默认就是包根 `SKILL.md` frontmatter 的名称。若历史条目的内部名与包根名称
不同，`shortcut.skillName` 提供经服务端核实的包根名称。
