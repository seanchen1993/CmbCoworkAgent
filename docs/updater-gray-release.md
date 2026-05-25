# 热更新灰度机制说明

> 适用版本：`feat/updater-gray-release` 起
> 相关代码：[checker.ts](../src/main/updater/checker.ts) · [gray-release.ts](../src/main/updater/gray-release.ts) · [index.ts](../src/main/updater/index.ts)

## 1. 背景与目标

历史上 `cmbdevclaw-latest.json` 是一份全局清单，所有客户端拿到的版本完全一致。任何一次发布都是 100% 直接铺开，缺少"先小范围验证再全量"的能力，新版本一旦带 bug，影响面是全行。

本次改造的目标是在**不改动服务端文件分发链路**的前提下，引入：

- 按**一事通用户 / SAP 员工号 / 组织 / 部门路径**圈选灰度人群
- 按**百分比**对剩余人群做哈希分桶放量
- 运营改 manifest 即可**踩刹车**，无需重新发版
- 客户端在**安装前再校验一次**，避免"刹车"后还有用户装上已撤回的版本

## 2. Manifest 协议

`cmbdevclaw-latest.json` 增加一个**可选**字段 `staging`，向后完全兼容（不写就是老行为）。

```jsonc
{
  // ===== 原稳定通道（兜底，必填） =====
  "version": "1.2.3",
  "minVersion": "1.0.0",
  "releaseNotes": "稳定版说明",
  "mandatory": false,
  "asar": { "file": "...", "sha256": "...", "size": 123456 },
  "full": { "file": "...", "sha256": "...", "size": 78900000 },
  "rollback": { "version": "1.2.2", "file": "...", "sha256": "..." },
  "platforms": {
    "win32": { "full": { ... }, "rollback": { ... } },
    "linux": { "full": { ... } }
  },

  // ===== 新增灰度通道（可选） =====
  "staging": {
    "version": "1.2.4",                      // 灰度候选版本，必须 > 当前版本才会生效
    "releaseNotes": "灰度版本说明",            // 缺省则继承顶层 releaseNotes
    "asar": { "file": "...", "sha256": "...", "size": 234567 },
    "full": { ... },
    "rollback": { ... },
    "platforms": { ... },

    "rolloutPercent": 10,                    // 百分比放量 0~100
    "rolloutSeed": "1.2.4-r1",               // 桶种子；不变则同一人桶位置稳定
    "whitelistUsers": ["123456", "00012345"],// ystId(6位) 或 sapId(8位)，强制命中
    "blacklistUsers": ["999999"],            // 强制不命中，优先级最高
    "whitelistOrgs": ["org-id-xxx"],         // 匹配 userInfo.originOrgId
    "whitelistPaths": ["总行/信息技术部"],     // 匹配 userInfo.pathName 前缀
    "includeAnonymous": false,               // 未登录用户是否参与，默认 false
    "minVersion": "1.2.0",                   // 低于此版本的客户端不参与灰度
    "expireAt": "2026-06-15T00:00:00Z"       // 过期后所有人回退到稳定通道
  }
}
```

### 字段语义要点

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `staging.version` | 是 | — | 必须严格大于客户端当前版本，否则视为未命中 |
| `rolloutPercent` | 是 | — | 实际生效值会被 clamp 到 `[0, 100]` |
| `rolloutSeed` | 否 | `staging.version` | 改 seed = 重新洗牌，慎用 |
| `whitelistUsers / Orgs / Paths` | 否 | `[]` | 任一命中即灰度，绕过百分比 |
| `blacklistUsers` | 否 | `[]` | 优先级最高，覆盖所有白名单 |
| `includeAnonymous` | 否 | `false` | 强烈建议保持 false |
| `minVersion` | 否 | 不限 | 老版本可能缺关键能力，跳灰度让它先升稳定 |
| `expireAt` | 否 | 永不过期 | 双重兜底；忘记下线的灰度不会无限期生效 |
| `mandatory` | — | 永远视为 `false` | 强制升级必须走稳定通道，否则灰度群体之外无法触达 |

## 3. 客户端通道选择（两层决策）

### 3.1 第一层：通道优先级（`selectChannelTarget`）

位于 [checker.ts:selectChannelTarget](../src/main/updater/checker.ts)，纯函数，决定该用户最终走哪个通道：

| 条件 | 结果 |
|---|---|
| `latest.mandatory === true` | **永远走 stable**（强制升级必须覆盖所有人，包括灰度群体） |
| `staging.version <= stable.version` | **忽略 staging**（稳定版已追平或反超，灰度块已过时） |
| 命中灰度 **且** staging 下载信息能解析出来 | **走 staging** |
| 命中灰度但 staging 缺 asar/full（manifest 半成品） | **回退 stable**（不能把灰度群体卡死在"无更新"状态） |
| 其余情况 | 走 stable |

### 3.2 第二层：是否命中灰度（`evaluateStaging`）

位于 [gray-release.ts:evaluateStaging](../src/main/updater/gray-release.ts)，纯函数。判定顺序（首个命中的规则生效）：

```
1. 没有 staging 块                                            → miss (no-staging-block)
2. expireAt 已过                                              → miss (staging-expired)
3. 当前版本 < staging.minVersion                              → miss (below-staging-minVersion)
4. 当前版本 >= staging.version                                → miss (staging-not-newer)
5. 未登录（没有 ystId 也没有 sapId）                          → 看 includeAnonymous
6. ystId 或 sapId 任一在 blacklistUsers                       → miss (blacklisted)
7. ystId 或 sapId 任一在 whitelistUsers                       → hit  (whitelist-user)
8. originOrgId 在 whitelistOrgs                               → hit  (whitelist-org)
9. pathName 以 whitelistPaths 任一前缀开头                    → hit  (whitelist-path)
10. bucket = sha1("<bucketKey>|<seed>") % 100
    bucket < rolloutPercent                                   → hit/miss (bucket=N/PCT)
```

**ID 匹配规则**：黑白名单条目允许写 ystId 或 sapId 任意一个，匹配时拿用户的两个 ID **任一命中即可**。运营在排黑名单时如果只知道 sapId，写 sapId 也能止血。

**bucketKey 优先级固定**：分桶用的 key 始终是 `ystId || sapId`（ystId 优先），确保同一个用户长期落在同一个桶里，不会因为运营改用哪个 ID 圈选而跳变。

`userInfo` 取自 [storage.ts:getUserInfo](../src/main/storage.ts)，外层用 `safeGetUserInfo` 包了一层 try/catch：用户信息 JSON 损坏时降级为匿名，**绝不阻塞稳定版更新**。

每次判定都会返回稳定的 `reason` 字符串（如 `whitelist-org`、`bucket=42/10`），写到日志便于排障：

```
[Updater] Staging hit: v1.2.4 reason=bucket=7/10 user=123456
[Updater] Stable: v1.2.3 grayReason=below-staging-minVersion
```

### 为什么用 ystId/sapId 而不是 machine-id

- **跟人走**：换机/重装不跳变，灰度结论与人的"应否参与"一致
- **运营直觉**：白名单写员工号、部门路径，看一眼就知道圈选了谁
- **跨设备 dogfood**：同一个开发者多台机器，登同一个一事通，体验一致
- 与 [dashboard.ts](../src/main/ipc/dashboard.ts) 已有的 `ALLOWED_YST_IDS` 等内部权限模式心智一致

## 4. 端到端流程

### 4.1 正常检查 → 下载 → 安装

```
启动 5s 后
  → fetchLatestJson
  → evaluateStaging(userInfo, current, staging)
      hit?  ─是→ 用 staging 块构造 UpdateCheckResult { channel: "staging", ... }
      hit?  ─否→ 用 stable 块构造 UpdateCheckResult { channel: "stable", ... }
  → 后台静默下载
  → broadcast "update:downloaded"
  → 用户点击安装
  → [新] 若 channel === "staging"，再 checkForUpdate 一次校验
  → installAsarUpdate / installFullUpdate
```

### 4.2 安装前二次校验（关键踩刹车点）

实现位于 [index.ts:update:install 处理器](../src/main/updater/index.ts)，对比函数 [gray-release.ts:isSameStagingPayload](../src/main/updater/gray-release.ts)。

仅在 `channel === "staging"` 时触发。判定通过 `isSameStagingPayload(expected, recheck)` 全字段比对：**version、updateType、downloadFile、downloadSha256、downloadSize、rollback 任一不一致就视为已变更**。这样可以覆盖到一种常见的灰度场景——**同版本号换包**：运营发现 v1.2.4 的某次构建有问题，用同版本号重新打了一份替换上去，sha256 变了但版本号没变。纯比对 version 会漏掉这种情况，让本地旧包照装。

| 二次校验返回 | 决策 |
|---|---|
| 网络/服务端错误（fetch 抛异常） | **放行安装**（避免误伤离线用户） |
| `null`（不再有更新） | 撤回，删本地包 |
| `channel === "stable"`（被踢出灰度） | 撤回，删本地包 |
| `channel === "staging"` 但任何下载字段（sha256/file/size/updateType/rollback）变了 | 撤回，删本地包 |
| 全部字段一致 | 放行安装 |

撤回时 `update:error` 广播提示 *"灰度策略已变更，本次更新已撤回。下次启动将重新检查。"*

为什么网络错误时放行：用户离线/弱网是常态，把这条路径变成硬阻塞会让边远用户永远装不上更新。灰度撤回是低频运营动作，错过一次窗口期下次启动还会重新分桶。

## 5. 运营手册

### 5.1 典型放量节奏

| 阶段 | manifest 改动 | 受众 | 验证项 |
|---|---|---|---|
| 0. dogfood | `rolloutPercent: 0` + `whitelistUsers: [核心开发者 5~10 人]` | <10 | 启动、热更安装、回滚 |
| 1. 部门内测 | 增加 `whitelistOrgs: [信息技术部 orgId]` | 几十~几百 | 主链路、关键 IPC、性能 |
| 2. 兄弟部门 | 追加更多 `whitelistOrgs` + `rolloutPercent: 5` | ~5% | 看上报数据 |
| 3. 阶梯放量 | `rolloutPercent: 10 → 30 → 60` | 每步观察 1~3 天 | 错误率、崩溃率 |
| 4. 收敛 | 把 `staging` 块**整体提升为顶层**（`version` 顶替），删 `staging` | 100% | / |

### 5.2 踩刹车

发现灰度版本有问题，三种递进的处理方式：

1. **黑名单单点止血**：把出问题的 ystId 加进 `blacklistUsers`，该用户下次检查回到稳定版（已下载未安装的包会在二次校验时被丢弃）。
2. **暂停放量**：`rolloutPercent: 0`，白名单仍然命中（保留 dogfood）。新分桶用户不再进灰度。
3. **完全撤回**：删除整个 `staging` 块。所有客户端立即回到稳定通道。

> 注意：CDN 对 `cmbdevclaw-latest.json` 必须保持**短 TTL 或 no-cache**，否则踩刹车要等缓存过期。

### 5.3 收敛操作

确认灰度稳定后要"提升为正式"：

1. 把 `staging.version` 复制到顶层 `version`，`staging.asar / full / platforms / rollback` 同步覆盖顶层对应字段
2. `releaseNotes` 用 staging 的值覆盖顶层
3. **删除整个 `staging` 块**（不要留 `rolloutPercent: 100`，会让所有新启动客户端走"灰度命中"日志路径，造成误读）
4. 顶层 `minVersion` 视情况上调

### 5.4 常见坑

- **rolloutSeed 不要随便改**：改了等于把所有桶重新洗牌，灰度内已升级的用户可能"被踢出灰度"——他们已经在用 staging 版本，但下次检查会把他们当稳定通道用户看待，导致显示"无更新"或意外回退路径。**只在确实需要全员重新分桶时改 seed**。
- **不要在 staging 写 `mandatory: true`**：代码已硬性忽略此值（staging 永远 `mandatory: false`），是为了防止"灰度群体内强制升、群体外完全不知情"的诡异状态。强制升级走稳定通道。
- **staging.rollback 应指向稳定版**：万一灰度版本需要回滚，目标必须是当前稳定版而不是"上一个灰度版本"。
- **未登录用户**：默认完全不参与灰度。如果业务上确实希望未登录也分桶，开 `includeAnonymous: true`，但要明白这部分用户没有稳定 bucketKey，每次都被当 anonymous 整体处理（要么全进要么全不进）。

## 6. FAQ

**Q：用户切了一事通账号，会发生什么？**
A：下次启动检查时按新账号重新分桶。若新账号不命中灰度而本机已下载灰度包未装——安装前二次校验会丢弃这个包。

**Q：同一台机器多人共用？**
A：按当前登录用户分桶。安装时还会再校验一次，确保不会把 A 命中的灰度版装到 B 的会话里。

**Q：服务端能不能完全静态？**
A：可以。整套机制不依赖任何动态接口，`cmbdevclaw-latest.json` 仍然是一份静态文件，所有决策在客户端做。

**Q：白名单里写明文 ystId 安全吗？**
A：manifest 是客户端可见的，名单是"可被任何客户端读到的明文信息"。如果觉得敏感，可改成 `sha256(ystId + salt)` 存储，并在客户端做同样处理后比对——本期未实现，按需扩展即可。

**Q：百分比放量会不会让同一个用户在升级版本和不升级版本之间反复横跳？**
A：不会。同一 `(ystId, seed)` 的 hash 是确定性的，只要 seed 不变，命中结论永久稳定。

**Q：怎么知道我是不是在灰度里？**
A：看主进程日志 `[Updater] Staging hit: ... reason=...` 或 `[Updater] Stable: ... grayReason=...`。后续可以把 `grayReason` 透出到"关于"页面便于自助排障。

## 7. 代码模块速查

| 文件 | 职责 |
|---|---|
| [semver.ts](../src/main/updater/semver.ts) | `compareSemver`，无依赖小工具，纯函数模块都依赖它 |
| [gray-release.ts](../src/main/updater/gray-release.ts) | `evaluateStaging`（命中判定）+ `isSameStagingPayload`（安装前比对），均为纯函数 |
| [checker.ts](../src/main/updater/checker.ts) | `LatestJson` / `StagingBlock` 协议定义；`selectChannelTarget` 纯函数选通道；`checkForUpdate` 是 fetch + 委托的薄壳 |
| [index.ts](../src/main/updater/index.ts) | IPC 编排；`update:install` 对 staging 通道做二次校验、踩刹车撤回 |
| [storage.ts](../src/main/storage.ts) | `getUserInfo()` 返回 `UserInfoConfig`，提供 ystId/sapId/orgId/pathName |

## 8. 测试

测试文件位于 [src/main/updater/gray-release.test.ts](../src/main/updater/gray-release.test.ts) 和 [src/main/updater/channel-selector.test.ts](../src/main/updater/channel-selector.test.ts)，共 44 个用例，覆盖：

- `evaluateStaging` 的所有判定分支（过期、minVersion、匿名、ystId/sapId 双向匹配、组织/路径白名单、百分比分桶、seed 重洗、clamp 越界）
- `selectChannelTarget` 的通道优先级（mandatory stable 压过 staging、stable 反超 staging 时忽略 staging、半成品 staging 回退 stable、平台路由）
- `isSameStagingPayload` 的同版本换包识别（sha256/file/size/updateType/rollback 任一改变都判定不一致）

运行：

```bash
npm run test          # 单次跑
npm run test:watch    # watch 模式
```
