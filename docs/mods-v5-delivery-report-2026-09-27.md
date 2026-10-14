# Mods V5：可行性复核与第一批基础补齐

## 当前结论

可以继续实现固定版本、明确范围的行为对齐；目前没有达到 Claude Mods 全量兼容。不能承诺所有版本、任意插件、CLI 与桌面界面、权限及运行边界完全相同。仅增加同名 API 或事件名，不构成行为对齐。

完整方案见 [可行性与 A–F 实施路线](mods-v5-full-parity-feasibility-plan-2026-09-27.md)。两位 agent 先通过方案评审，再分别实现和交叉检视。本轮完成 A 的注册事件检查及 B 的 URL 纵向能力；其余项目继续明确列为未实现。

工作目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。没有在 UAT 开发，没有提交或推送，保留之前所有未提交工作。

## 实际使用效果

### 插件不会触发时，能先看到原因

打开“自定义 → Function Mods”，选择有项目目录的会话，在对应插件的权限卡片点击“检查事件兼容性”。

- 注册 `classic.FileChanged` 的插件会提示“存在无法生效的事件”，说明当前只有事件结构，没有实际文件变化触发点。
- `session.send`、`process.spawn`、`session.root`、`session.version` 等已核对但尚未实现的事件会得到明确诊断。
- 注册 `*` 或负模式的观察器会显示“部分事件尚未接入”，保留已接入事件的工作能力。
- 未知自定义事件显示“尚未验证”，因为可能依赖其他插件的提供者。

检查会在独立 QuickJS 进程中执行模块初始化和注册，读取注册清单；不执行事件回调、不发放授权、不改变项目开关。只有点击才启动检查，刷新状态不创建额外 VM。插件源码、项目作用域或运行时版本变化后，过期结果不会返回成功；关闭和全局失效会停止检查进程。

检查范围明确是**注册事件的生产接入**，不能验证任意动态 SDK 调用、匹配器业务条件、权限和最终业务效果。显示“已有适配器”仍然不是 Claude 全兼容证明。

开发者可使用：

```sh
node bin/cli.js plugin check <插件目录>
node bin/cli.js plugin check <插件目录> --strict-compatibility
```

默认保留原有 `valid` 退出语义，报告增加 `packageValid` 和 `compatibility`；严格模式在明确缺失、未知提供者或没有可检查注册时返回非零。可工作的通配观察器仍可通过严格检查，同时报告其部分覆盖范围。

### 插件可以直接使用 URL 标准接口

Hooks 和隔离 Client 中可以使用 URL、URLSearchParams，包括相对路径、国际化域名、IPv6、file/opaque URL、查询参数重复项、迭代排序、可变属性及 URL 与 searchParams 双向联动。

```ts
const target = new URL("../report?owner=张三", "https://example.com/tasks/current")
target.searchParams.append("stage", "review")
target.searchParams.append("stage", "test")
const stages = target.searchParams.getAll("stage")
```

使用锁定的 whatwg-url 14.2.0，在原 QuickJS 中按需初始化。宿主 URL 对象不跨越隔离边界，50ms 执行片、16MiB 内存和禁止代码生成的限制保持不变。生成资源带依赖版本、许可证及可复现校验，不在用户启动应用时临时下载或打包。

未提供 Blob/object URL。IDNA 的一个双向文本标签边界与 Node 不同，已保留独立回归和说明；没有把 Node 差分当作 Claude 完全等价证明。详情见 [兼容增量说明](mods-v5-compatibility-delta-2026-09-27.md)及 [机器可读增量](mods-v5-compatibility-delta-2026-09-27.json)。

## 检视中修复的问题

1. 检查的最终异步编译完成后必须再验证 epoch，避免并发失效返回过期报告。
2. 检查从初次编译开始就登记项目归属，`invalidateAll()` 必须覆盖尚未创建 VM 的检查，且释放 busy 状态。
3. URL 按需初始化不能覆盖作者已经删除、替换或锁定的同名全局变量；库只返回私有构造器，逐一替换仍属于自身的 getter。
4. 许可证收集从实际 bundle 输入定位依赖版本，避免顶层同名包与嵌套依赖版本不同而记录错误。

两个 agent 已交叉检视修复后的代码，无剩余阻断意见。

## 存量用户影响

- 原普通插件、会话、DIY 步骤配置和项目完成规则保留；兼容诊断不会自动禁用或撤销现有插件。
- Function Mods 运行时修订号变更为 `url-globals-v67`，已有 Function Mods 授权摘要会过期，需要对新版本重新授权。这是有意保留的授权边界。
- 原来的未接入事件仍不会生效；本轮让缺口可见，没有把诊断提示冒充事件实现。
- 默认关闭 Mods、撤权、关闭后的普通输入框、命名状态联动和既有 Autobiz DIY 路线均纳入回归。

## 尚未完成

| 路线 | 当前状态与下一步 |
| --- | --- |
| A 支持事实与检查 | 本轮已完成注册事件诊断；目录不是 2.1.283 全部声明的完整审计 |
| B 标准环境 | URL 已接入；AbortController/Signal、structuredClone、crypto/performance 等仍需补齐 |
| C 资源与 SDK | 先实现模块资源生命周期和独立流协议，再实现 process.run/spawn、clock.after/every、http.fetch |
| D 消息与业务事件 | 真实 inbox、session.send/receive、agent.spawn，以及缺失的 prompt/config/classic 业务接入 |
| E 作者工具与界面 | manifest.types、类型注册/生成、其余 JSX/Client 界面语义 |
| F 等价性与交付 | 固定上游运行时差分、跨平台打包、完整桌面延迟和长时间稳定性验收 |

尤其不能直接复用现有 turn.step 流来实现 process.spawn：上游允许仍在迭代的子进程跨越 hook 返回继续存活，而当前 invocation 结束会回收调用权限。session.send 的成功代表消息入队，也不能用伪造用户消息或直接启动任务替代。底层方案已在主计划中拆清。

## 测试验收记录

| 范围 | 结果 |
| --- | --- |
| 兼容回归集 | 更新后的 `test:mods:compat` 覆盖 12 文件 221 项，最终全库报告中这些用例全部通过 |
| 新增逻辑与失败重检 | URL、事件目录、manager 竞态及 Windows 子进程用例共 4 文件 54 项通过；未放宽断言 |
| CLI 生产入口 | 7 组通过，包括真实 bin 参数转发、Electron CLI、utilityProcess、默认与严格退出码 |
| 真实隔离进程 | `test:mods:function:process` 通过，包含 Hooks/Client URL 及既有宿主链 |
| Electron 功能回归 | 4 场景共 19 条记录通过：兼容检查、URL、命名状态、代码生成隔离；含撤权、重载及关闭后原输入框 |
| 浏览器交互 | Mods 设置与读取者 10 组通过，包括检查无自动 IPC、旧项目/旧源码结果失效、busy 后恢复 |
| Autobiz DIY | 浏览器 5 组、生产 Electron 7 组通过；真实步骤排序/选择模型、代码修复、原生复检、人工批准后唯一阶段提交、重启不重放 |
| 类型与构建 | Node/Web 类型检查及普通生产构建通过；E2E finally 已恢复普通产物 |
| 全库 Vitest | 最终冻结版本 4959 项：4928 通过、26 失败、5 跳过；按完整测试名与 V4 基线对比，无新增失败，无消失的历史失败 |
| 全库 lint | 未通过：100 errors、585999 warnings，错误位于本轮未修改文件；不全仓格式化、不掩盖已有质量债务 |

模型 E2E 使用本地受控协议 fixture，验证生产业务链，不是对远程 LLM 的效果评测。浏览器 64 步编辑器本次 p95 为 33.5ms，不能据此推断整机 TTFT 或所有负载都已优化。

### npm test 的独立子链

在全库 Vitest 之外逐组运行 `npm test` 中的全部 9 条独立子链：adoption、messages、hooks、plugins、task-cards、merge、workflow、desktop-agent-baseline、im-v1。7 条通过，workflow/im-v1 仍遇到旧失败。对提前停止后的后续 31 个脚本继续逐个执行，29 通过、2 个保留历史失败。

- `local-sandbox-worktree-isolation`：PowerShell 无法执行测试固定的 Bash 命令 `pwd -W`；显式 Git Bash 原样重跑已通过，未修改生产代码。
- `im-remote-approval`：Windows 路径分隔符与固定 POSIX 字符串断言不一致，当前 suite 在该断言停止，后续内部用例不计为本轮通过。
- `sandbox-elevated`：85 通过、2 个原有工作流通知静态断言失败。
- `im-local-zhaohu-journey`：原有项目会话回复格式断言不一致。

以上有 [V2 逐项确认](mods-v2-existing-failures-confirmation-2026-09-26.md)和 [V3 复核](mods-v3-delivery-report-2026-09-27.md)的同因记录；本轮又由 agent 只读核对归因。不能称整条 `npm test` 全绿。

全库首轮在最后修复落盘期间运行，出现旧 URL 库、新边界测试和目录缓存的混合版本失败，以及 Windows 临时可执行文件 EBUSY。保留首轮日志，不用它代表最终版本；原断言定向重检全部通过后，冻结代码再次运行全库。

### 性能复核

测试全部退出后，使用最终代码测量 60 对交替 VM 创建样本，另有 10 对热身，保持相同资源上限：

- 不含 URL 安装的基线 p50/p95：3.482/3.590ms。
- 安装按需入口但不使用 URL 的 p50/p95：3.620/3.829ms，p95 增加 0.239ms。
- 首次 URL 使用 p95：21.143ms；后续同 VM 使用 p95：0.361ms。

这避免了每个插件冷启动都解析整套库，但不是零成本，也不是整机性能提升结论。该测量不包括 IPC、磁盘、模型和 TTFT，不能覆盖历史整机 TTFT 增量超预算或代替长时间内存验收。并行测试时的较高样本已另存 `url-performance-concurrent.json`；最终静态测量是 `url-performance.json`，两份均保留，不混合计算。

### 可复现入口与产物

使用工程要求的 Node 22：

```sh
npm run test:mods:compat
npm run test:mods:url-generated
npm run test:mods:function:process
npm run build
npm run test:mods:compat-cli
node tests/run-mods-e2e.mjs compatibility url named-state guest-codegen
npx tsx tests/mods-review-browser.spec.ts
npx tsx tests/mods-flow-browser.spec.ts
npx tsx tests/mods-flow-e2e.spec.ts
npm run typecheck
```

`test:mods:compat-cli` 要先有普通生产构建；E2E runner 会恢复普通构建。开发源码和测试专用产物不混同于已发布安装包，本轮没有重新验证跨平台安装器。

所有测试证据保存在 `output/mods-v5-validation/`，桌面截图在 `output/mods-validation/e2e-compatibility/`、`e2e-url/` 等目录。首轮全库 JSON 是 `output/mods-v5-full-vitest.json`，冻结后的结果是 `output/mods-v5-final-vitest.json`，逐项对比结果为 `output/mods-v5-validation/final-baseline-comparison.json`。
