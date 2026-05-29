# Hook 实测案例

实操指南：每个 hook 事件/类型给一个**最小可验证**的配置 + 给 agent 的提问 + 观察点。

## 通用约定

**统一观察文件**：所有命令型 hook 都用同一个 helper 把一行追加到 `c:\tmp\hook-trace.log`：

```
node "C:\ai\CmbCoworkAgent\tests\support\append-line.cjs" "C:\tmp\hook-trace.log" <TAG>
```

- `<TAG>` 自己换成识别字符串，例如 `PRE-EXECUTE`、`POST-EDIT` 等
- 不存在的文件会自动创建，永远 append，不会污染前次记录
- 每次实测前 PowerShell 跑一下清空：
  ```powershell
  Remove-Item -Force C:\tmp\hook-trace.log -ErrorAction SilentlyContinue
  ```
- 验证：`Get-Content C:\tmp\hook-trace.log`（或在 git bash 用 `cat`）

**怎么配 hook**：自定义 → 钩子 → 右上角"添加 Hook" → 按下表填字段。

**怎么删 hook**：列表里点 hook → 详情面板"删除"，或直接禁用即可。

---

## Phase 2 新加的能力

### 1. `Setup` 事件 — workspace 初始化（init / maintenance）

**1.1 init 子触发** — 每个新 workspace 第一次开 thread 时触发一次

| 字段 | 值 |
|---|---|
| 事件 | `Setup` |
| matcher | `init` |
| 类型 | command |
| 命令 | `node "C:\ai\CmbCoworkAgent\tests\support\append-line.cjs" "C:\tmp\hook-trace.log" SETUP-INIT` |

**测试步骤**：
1. 在某个**新文件夹**（没有 `.cmbcoworkagent/setup-state.json`）打开/创建 thread
2. 给 agent 发任何提问，比如 `"你好"`
3. 应观察到 `c:\tmp\hook-trace.log` 出现 `SETUP-INIT` 一行
4. 再开一个新 thread 指向同 workspace → 不应再出现新行（per-workspace dedupe 生效）

**预期失败行为验证**：把命令改成 `cmd /c exit 1`，删掉该 workspace 的 `.cmbcoworkagent/setup-state.json`，再起 thread → marker 不应被写出，下次再起还会重试。

---

**1.2 maintenance 子触发** — 用户主动重新初始化

| 字段 | 值 |
|---|---|
| 事件 | `Setup` |
| matcher | `maintenance` |
| 类型 | command |
| 命令 | `node "C:\ai\CmbCoworkAgent\tests\support\append-line.cjs" "C:\tmp\hook-trace.log" SETUP-MAINTENANCE` |

**测试步骤**：
1. chat 头部点工作区下拉（文件夹名旁）→ 弹层底部点"重新初始化工作区"
2. toast 提示 `已触发工作区 Setup hooks（maintenance）`
3. `c:\tmp\hook-trace.log` 出现 `SETUP-MAINTENANCE`
4. `.cmbcoworkagent/setup-state.json` **mtime 不变**（maintenance 不写 marker）

---

### 2. `PostToolUseFailure` — 工具调用失败时触发

覆盖 5 种失败：throw / 非零退出 / 显式 error / abort / timeout。

| 字段 | 值 |
|---|---|
| 事件 | `PostToolUseFailure` |
| matcher | `*` |
| 类型 | command |
| 命令 | `node "C:\ai\CmbCoworkAgent\tests\support\append-line.cjs" "C:\tmp\hook-trace.log" TOOL-FAILURE` |

**触发提问**：
- 非零退出：`"用 execute 工具运行 exit 5"`
- 不存在的命令：`"用 execute 工具运行 nosuchbinary123"`
- 文件不存在：`"读 c:/this/does/not/exist.txt"`

**观察**：每个失败一行 `TOOL-FAILURE`。如果想看分类，把命令换成附带 env 的版本：
```
node "C:\ai\CmbCoworkAgent\tests\support\append-line.cjs" "C:\tmp\hook-trace.log" "FAIL %CLAUDE_TOOL_NAME%"
```

---

### 3. `SubagentStart` / `SubagentStop` — task 工具的子代理生命周期

**配两个 hook 一起观察**：

| 事件 | matcher | 命令 |
|---|---|---|
| `SubagentStart` | `*` | `node "..." "C:\tmp\hook-trace.log" "SUB-START"` |
| `SubagentStop` | `*` | `node "..." "C:\tmp\hook-trace.log" "SUB-STOP"` |

**触发提问**：
```
用 task 工具派一个子代理去做一件事：让它跑 `node -e "console.log(2+2)"` 然后回报结果。
```

**预期**：trace 文件按顺序出现 `SUB-START`、子代理输出、`SUB-STOP`。如果发了多个 task call，应每对成对出现且 tool_call_id 一一对应。

---

### 4. `StopFailure` — turn 因 API 错误异常结束

| 字段 | 值 |
|---|---|
| 事件 | `StopFailure` |
| matcher | `*`（或 `rate_limit` / `authentication_failed` 等精确分类） |
| 类型 | command |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "STOP-FAILURE"` |

**触发**：
- 临时把当前默认模型的 apiKey 改成乱字符串（设置 → 模型 → 编辑）
- 给 agent 任意提问
- turn 应失败，`STOP-FAILURE` 出现一行
- 把 apiKey 改回去

**反向用例**（验证互斥）：apiKey 正确时，给 agent 提任意正常问题 → 只应触发 `Stop`、**不**触发 `StopFailure`。配一个 `Stop` matcher=`*` hook 一起观察。

---

### 5. `type: "http"` — HTTP hook

需要本地起一个收 POST 的服务。把这段保存为 `c:\tmp\hook-server.js`：

```javascript
require('http').createServer((req, res) => {
  let body = ''
  req.on('data', c => body += c)
  req.on('end', () => {
    console.log(new Date().toISOString(), req.method, req.url, '→', body.slice(0, 200))
    res.end('{"decision":"approve"}')
  })
}).listen(9999, () => console.log('listening on 9999'))
```

运行：`node c:\tmp\hook-server.js`

**hook 配置**：

| 字段 | 值 |
|---|---|
| 事件 | `PreToolUse` |
| matcher | `execute` |
| 类型 | http |
| URL | `http://127.0.0.1:9999/pre-execute` |
| Headers | `X-Source: claude-code` |
| allowedEnvVars | （留空） |

**触发提问**：`"用 execute 跑 echo hi"`

**观察**：服务端控制台打印 POST 请求体，应含 `"hook_event_name":"PreToolUse"`、`"tool_name":"execute"`、`"tool_input":{"command":"echo hi"}`。

**变种 — 环境变量插值**：
- header 改成 `X-User: $USER`（Windows 设环境变量 `setx USER mickey` 后重启 hook）
- allowedEnvVars 留空 → 服务端收到 `X-User: ""`（被白名单挡掉）
- allowedEnvVars 填 `USER` → 服务端收到 `X-User: mickey`

---

### 6. `async: true` 修饰符 — 后台运行 hook

**配置**：拿 #5 那个 PreToolUse HTTP hook，把 timeout 拉到 5000ms 并打开 **异步执行** 开关。或者用一个 sleep 命令：

| 字段 | 值 |
|---|---|
| 事件 | `PreToolUse` |
| matcher | `*` |
| 类型 | command |
| 命令 | `node -e "setTimeout(()=>require('fs').appendFileSync('C:\\\\tmp\\\\hook-trace.log','ASYNC-LATE\n'),3000)"` |
| 异步 | ✅ |

**触发提问**：`"读 package.json 前 5 行"`

**观察**：
- 工具调用**立即**进行（hook 不阻塞）
- 自定义→钩子→选中该 hook 在右侧详情看 hook log 应看到 **pending** 状态先出现
- 约 3 秒后 hook log 增加 **completed**，`C:\tmp\hook-trace.log` 出现 `ASYNC-LATE`

**强约束**：`Setup` 事件 + `async: true` 在保存时会被拒绝（错误信息：`Setup Hook 必须同步执行`）。可以试一下确认验证生效。

---

### 7. `matcher` 按事件分发 + `if` 子句

**7.1 SessionEnd 按 reason 区分**

| 事件 | matcher | 命令 |
|---|---|---|
| `SessionEnd` | `clear` | `node "..." "C:\tmp\hook-trace.log" "END-CLEAR"` |
| `SessionEnd` | `logout` | `node "..." "C:\tmp\hook-trace.log" "END-LOGOUT"` |

**触发**：
- 删一个 thread → 应只见 `END-CLEAR`
- 完全关闭 app → 应只见 `END-LOGOUT`（看 trace 文件）

**7.2 `if` 子句过滤**

| 字段 | 值 |
|---|---|
| 事件 | `PreToolUse` |
| matcher | `execute` |
| **if** | `execute(git *)` |
| 类型 | command |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "GIT-COMMAND"` |

**触发对比**：
- `"用 execute 跑 ls"` → **不应**出现 GIT-COMMAND
- `"用 execute 跑 git status"` → **应**出现 GIT-COMMAND

---

## 存量 hook 事件（PR 之前就有）

### `PreToolUse` — 任何工具调用前

| 字段 | 值 |
|---|---|
| 事件 | `PreToolUse` |
| matcher | `execute`（或 `*` 匹配所有工具） |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "PRE-EXECUTE"` |

**提问**：`"用 execute 跑 echo hello"` → 一行 `PRE-EXECUTE`。

**进阶**：matcher 改 `read_file`，提问 `"读 package.json"` → 应触发。

### `PostToolUse` — 任何工具调用后

跟 PreToolUse 同理。matcher 设 `execute`，命令 tag 改 `POST-EXECUTE`。

**提问**：`"用 execute 跑 echo done"`

**观察**：trace 顺序应是 `PRE-EXECUTE` → 工具实际执行 → `POST-EXECUTE`。

### `UserPromptSubmit` — 用户每次发消息

| 字段 | 值 |
|---|---|
| 事件 | `UserPromptSubmit` |
| matcher | `*` |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "USER-PROMPT"` |

**提问**：发任意消息 `"hi"` → 一行 `USER-PROMPT`。再发一条 → 又一行。

### `SessionStart` — thread 第一次启动时

| 字段 | 值 |
|---|---|
| 事件 | `SessionStart` |
| matcher | `*`（或 `startup`） |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "SESSION-START"` |

**提问**：开**新** thread + 任意提问 `"hi"`（旧 thread 的 SessionStart 已经在打开时触发过）。同 thread 第二次提问**不会**再触发。

### `Stop` — turn 正常结束

| 字段 | 值 |
|---|---|
| 事件 | `Stop` |
| matcher | `*` |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "STOP"` |

**提问**：`"hi 用一个词回复"` → turn 结束 → 一行 `STOP`。

**配合 `forcedOutcome` 测阻断**：详情面板把 `forcedOutcome` 设 `block`、`forcedReason` 设 `"测试 Stop 阻断"` → turn 应被中止，UI 显示 reason。

### `Notification` — 审批请求时

需要先把沙箱模式切到非 yolo（设置 → 沙箱 → 选 unelevated/readonly/elevated 之一），让需要审批的工具调用先弹审批。

| 字段 | 值 |
|---|---|
| 事件 | `Notification` |
| matcher | `permission_prompt`（PR-16 后的标准 matcher） |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "NOTIF-APPROVAL"` |

**提问**：`"用 execute 跑一个需要审批的命令，比如 npm install"` → 弹审批 → 一行 `NOTIF-APPROVAL` 出现（无论你 approve 还是 reject）。

**legacy fallback 验证**：matcher 改 `execute`（PR-16 的 dual-matcher fallback 仍然支持），同样触发 → 验证向后兼容。

### `PreSkillUse` / `PostSkillUse` — 技能读取前/后

需要项目里有可用 skill 触发。在 customize → 技能 里看自己有哪些 skill。挑一个 skill name，例如 `arch-guard`：

| 字段 | 值 |
|---|---|
| 事件 | `PreSkillUse` |
| matcher | `arch-guard`（skill name，不是工具名！） |
| 命令 | `node "..." "C:\tmp\hook-trace.log" "PRE-SKILL"` |

**提问**：发一个会触发该 skill 的请求（具体提问方式取决于 skill 的 description 触发规则；通常用 skill 描述里提到的关键词即可）

**预期**：技能被激活前 `PRE-SKILL` 一行，激活后续工具调用，最后 `PostSkillUse`（如果配了）。

---

## 实测顺序建议

1. 先把 `c:\tmp\hook-trace.log` 用 PowerShell 删了
2. 一次只启用一个目标 hook（其他全禁用，避免噪音）—— 现在列表会把启用的放最上面了
3. 按上面顺序逐个跑
4. 每跑完一个 `Get-Content C:\tmp\hook-trace.log` 验证
5. 然后禁用、跑下一个

---

## 如果 hook 没触发，先排查

- hook 的 enabled 是否打开（详情面板右上角开关）
- matcher 写对了吗（Setup 用 `init`/`maintenance`、SessionEnd 用 `clear`/`logout`、StopFailure 用错误分类，**不是工具名**）
- 看 Electron 主进程 console 有无 `[Hooks] <event> hook error:` 警告
- 把"诊断日志"打开（自定义→钩子→右上角设置图标），hook 详情会显示每次执行的 stdout/stderr
- 命令路径里有空格务必用双引号包起来
