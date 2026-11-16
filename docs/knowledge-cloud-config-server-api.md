# 知识库配置查询接口：企业内网服务端开发交接

本文是企业内网 agent 的服务端接口定义。总体设计见 [知识库设计](knowledge-cloud-config-api-design.md)，实施步骤见 [服务端实施计划](plans/2026-10-21-knowledge-cloud-server.md)，表结构见 [DDL](knowledge-cloud-config-mysql57.sql)。

只开发查询接口及必要的配置校验，不建设管理端，不执行 Git，不管理客户端本机文件，不接收或返回知识沉淀内容。服务端工程不在当前仓库中；使用目标工程已有语言、框架、数据访问和认证设施，不自行新建技术栈。

## 1. 接口

```text
POST /devclaw/knowledge-config/query
Content-Type: application/json
Accept: application/json
```

请求体：

```json
{
  "sapId": "00012345",
  "pathName": "总行/信息技术部/a组",
  "originPathId": "root-id/it-id/team-a-id"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| sapId | string | 是 | APP 当前用户员工编号，身份信息缺失时传空字符串 |
| pathName | string | 是 | APP 当前用户组织名称路径，缺失时传空字符串 |
| originPathId | string | 是 | APP 当前用户组织标识路径，缺失时传空字符串 |

仅传上述字段，不传整个 `userinfo-models.json`、插件列表、revision、密码或令牌。字段缺失、null、数字、数组或对象均返回 `40001`；空字符串是合法值。身份认证沿用企业服务现有机制，不把请求体中的员工编号当作认证凭证，不为本接口另造认证流程。

## 2. 初始组织匹配规则

组织过滤只在服务端执行，APP 直接使用结果。

数据库 `enable_org` 为 `VARCHAR(1000)` JSON 字符串，支持：

```json
{"global":true,"orgNames":[]}
```

```json
{"global":false,"orgNames":["a组","b室"]}
```

初始规则：

1. `global` 必须为 boolean，`orgNames` 必须为字符串数组。组织名不得为空或仅有空白，校验后匹配时去除组织名首尾空白并去重；`global=true` 时忽略组织名对匹配的影响。
2. `global=true` 的记录始终匹配。
3. 将请求 `pathName` 按 `/` 分割，去除各段首尾空白并忽略空段。任一完整路径段与 `orgNames` 任一名称精确相等即匹配，不做子串或组织层级覆盖。
4. `pathName` 没有有效路径段时只匹配全局库；非全局且 `orgNames=[]` 的记录对任何用户均不可见。
5. 同一记录命中多个路径段也仅返回一次。
6. `sapId` 和 `originPathId` 作为固定请求契约保留，初始匹配不增加按员工或组织 ID 的新规则。以后调整组织判断在服务端进行，不要求客户端跟随修改。

过滤前校验读取记录的 `enable_org`，无法解释组织规则时返回 `50002`，不能把坏配置当成不匹配。其他对外字段至少校验最终匹配记录；不匹配记录的内容不得出现在错误消息或响应中。

本接口返回可见清单，不承担客户端已下载内容的撤回：APP 保留历史目录，已有绑定在本地目录状态允许时仍能使用。

## 3. 完整成功响应

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "items": [
      {
        "idKey": "kb-payment-main",
        "name": "支付研发知识库",
        "description": "支付业务知识",
        "repoUrl": "https://git.example.com/payment-knowledge.git",
        "sshUrl": "git@git.example.com:payment-knowledge.git",
        "gitRef": "main",
        "ownerName": "示例发布人",
        "ownerId": "example-owner",
        "customConfig": "{}",
        "createdAt": "2026-10-21 10:00:00",
        "updatedAt": "2026-10-21 10:00:00"
      }
    ]
  }
}
```

`data.items` 包含当前请求身份可见的全部记录，无分页、无增量、无截断。空表、无匹配、只有不匹配的组织记录均返回 `{"code":200,"message":"success","data":{"items":[]}}`。可按 `id_key` 升序稳定返回。

### 返回字段白名单

| API 字段 | 数据库列 | 类型与约束 |
| --- | --- | --- |
| idKey | id_key | string，1–40 字符，不可变且唯一，能够安全作为单个目录名 |
| name | name | string，1–128 字符，全局唯一，无首尾空白，原值返回 |
| description | description | string，最多 300 字符，可以为空字符串 |
| repoUrl | repo_url | string，非空，最多 2048 字符，合法远程 Git URL |
| sshUrl | ssh_url | string 或 null，最多 2048 字符；未配置时返回 null |
| gitRef | git_ref | string，合法 Git 分支，最多 255 字符；空配置统一返回 main |
| ownerName | owner_name | string，最多 64 字符 |
| ownerId | owner_id | string，最多 32 字符 |
| customConfig | custom_config | string，最多 2048 字符，按文本透传，不改成对象 |
| createdAt | created_at | string，GMT+8 YYYY-MM-DD HH:mm:ss |
| updatedAt | updated_at | string，GMT+8 YYYY-MM-DD HH:mm:ss |

必须显式定义响应 DTO 和列映射，不序列化数据库实体。不得返回 `enableOrg`、`enable_org`、`devopsId`、`devopsKey`、`devops_key` 或未列出的数据库列。客户端无需知道服务端组织规则。

### 配置校验边界

- `id_key` 只能是单层目录名，不允许空白值、路径分隔符、`.`、`..`、控制字符及目标平台非法目录值；复用工程已有标识校验，无现成校验时与 APP 的目录约束对齐。
- `name` 不 trim、不转大小写、不自动改名。人工 SQL 提供合法值，查询发现首尾空白或空名称时报错。全局唯一由 `UNIQUE(name)` 保证，使用表的 `utf8mb4_general_ci` 比较规则；该规则可能把除大小写之外的部分字符也视为相等，不用应用层比较替代数据库唯一约束。
- 不增加 `(repo_url, git_ref)` 唯一约束。同仓库 `main` 与 `develop` 可以使用不同 ID、不同名称分别返回。
- Git URL 不得为本地路径或 `file:` URL，不允许控制字符、选项形式地址。支持现有客户端可解析的 HTTP、HTTPS、SSH、Git 协议和 SSH 的 `user@host:path` 形式。只校验格式，不在接口中访问仓库或校验仓库权限。
- `gitRef` 是分支，不接受 tag/commit 作为替代概念。只做分支名称格式校验，不发起远程 Git 查询。
- 日期由数据库 GMT+8 墙上时间格式化，序列化时不得再次当 UTC 转换；不用带 T 的日期格式。
- 返回项的 `idKey` 不得重复；匹配项中任何一项无效，整个请求返回 `50002`，不返回有效项组成的部分列表。

## 4. 错误响应

所有应用业务结果使用 HTTP 200：

```json
{
  "code": 50002,
  "message": "知识库配置无效，请联系维护人员",
  "data": null
}
```

| code | 场景 |
| --- | --- |
| 200 | 完整成功，包括零项 |
| 40001 | 请求非 JSON 对象，必填字段缺失或类型不对 |
| 50001 | 数据库或服务读取失败 |
| 50002 | 配置校验失败、结果序列化失败或超过服务已有响应限制 |

服务已有认证拒绝或网关传输错误沿用现有 HTTP 行为；APP 对非 HTTP 200 按请求失败处理。错误不能伪装成成功空数组。错误响应不包含凭据、内部 SQL、堆栈、仓库中的凭据或其他组织的配置；详细原因只写服务端受控日志，并去除凭据。

## 5. 数据库与部署边界

基线 DDL 使用 `PRIMARY KEY(id_key)` 和 `UNIQUE(name)`，配置仍由人工维护。数据库连接使用严格 SQL mode，session time_zone 为 `+08:00`。不要为了查询接口修改历史记录或自动补名称，不增加定时任务、缓存、版本号或管理接口。

若目标环境已经存在旧表，先只读检查实际表结构和名称重复数据，再向负责人确认是否清理重名、如何修改索引。不得直接执行基线 CREATE、自动改名、清表或默认提供迁移兼容逻辑。

服务端不返回客户端 `read`/`write` 路径或同步状态；双目录、失败重试、项目绑定和知识沉淀全部是 APP 职责。

## 6. 联调交付

内网 agent 交付接口代码、必要的定向自动化测试、实际启动/测试命令，以及可执行的请求示例。最小请求示例：

```bash
curl --request POST 'https://<企业服务域名>/devclaw/knowledge-config/query' \
  --header 'Content-Type: application/json' \
  --header 'Accept: application/json' \
  --data '{"sapId":"00012345","pathName":"总行/信息技术部/a组","originPathId":"root-id/it-id/team-a-id"}'
```

已有认证要求按内网工程补充，文档和测试报告不得填入真实凭据。服务端不要求当前仓库的客户端代码作为运行依赖。

### 7 DDL

-- 组织知识库配置 MySQL 5.7 基线 DDL；MySQL 8.0 亦可使用。
-- 仅为设计交付，不由客户端或应用启动自动执行。
-- 所有连接均须使用严格 SQL mode，并初始化 session time_zone = '+08:00'。
-- DATETIME 保存 GMT+8 墙上时间；API 输出 YYYY-MM-DD HH:mm:ss，无 ISO T。
-- id_key 是不可变的内部标识；name 是全局唯一业务名称，目录名不直接使用 name。
-- name 人工写入时不得为空或带首尾空白；查询接口只校验，不清洗、不改写。
-- name 判重采用本表 utf8mb4_general_ci 排序规则，大小写差异不能作为不同名称。
-- 同仓库不同分支使用不同 id_key 和 name，不增加仓库加分支唯一约束。
-- 此文件为目标基线；已有表结构和同名数据如何调整须另行确认，不自动迁移。
-- MySQL 5.7 不执行 CHECK 约束，字段格式及业务有效性由服务端校验。
-- enable_org 存储 JSON 字符串：{"global":true,"orgNames":[]} 或 {"global":false,"orgNames":["a组","b室"]}。
-- 不使用外键、触发器、级联或关联更新；一期由人工维护此表。
-- 不用 IF NOT EXISTS，避免静默忽略已有不一致结构。

CREATE TABLE devclaw_knowledge_config (
id_key VARCHAR(40) NOT NULL COMMENT '不可变的知识库标识',
name VARCHAR(128)  NOT NULL COMMENT '全局唯一知识库名称',
description VARCHAR(300)  NOT NULL COMMENT '知识库描述',
repo_url VARCHAR(2048) NOT NULL COMMENT 'Git地址',
ssh_url VARCHAR(2048) NULL COMMENT 'SSH地址',
git_ref VARCHAR(255) NOT NULL DEFAULT 'main' COMMENT '指定分支',
created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'GMT+8',
updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'GMT+8',
owner_name varchar(64) NOT NULL COMMENT '发布人姓名',
owner_id varchar(32) NOT NULL COMMENT '发布人id',
enable_org VARCHAR(1000) NOT NULL COMMENT '生效组织名称范围，JSON字符串',
devops_id varchar(32) NOT NULL COMMENT 'devops账号',
devops_key VARCHAR(128) NOT NULL COMMENT 'devopskey,用于发起知识沉淀更新',
custom_config VARCHAR(2048) NOT NULL COMMENT '知识库个性化配置',
PRIMARY KEY (id_key),
UNIQUE KEY uk_km_knowledge_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
COMMENT='知识库定义';
