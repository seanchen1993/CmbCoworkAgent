# Mods 四项审查问题修复与复审

日期：2026-10-22。分支：`codex/mods-v2`。
本次在已有未提交的收敛实现上修复，不重置原有功能、设置和版本改动。

## 修复结果

| 审查问题                                       | 修复                                                                                                           | 回归依据                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 流式追加清空安全正文                           | 已提交投影在同一 append lineage 内保留；捕获配对的原生渲染委托；旧输入交互保持 inert；替换、ABA 与真实失效撤销 | 真实 FunctionSite 浏览器检查正文、DOM 身份、委托、点击及失效后迟到回包                 |
| renderer 缓存 admission 淘汰撤掉活跃内容       | 当前视图依赖 scope/ticket/input，有效展示不依赖可选缓存保留资格                                                | 100 个命令输出槽全部完成并显示；无关重渲染不补读；实际宿主失效仍撤销目标行             |
| 96 个依赖 proof 后不再缓存新消息               | 通过同 scope 缓存 LRU 回收旧 proof，再重新读取依赖并验证额度/版本；保留 96/8192/4MiB 等原限额                  | 第 97 条消息可以缓存，立即重访不求值；最近访问条目保留；淘汰回调改写源码导致拒绝       |
| native child 长消息落入 10,000 字符 guest 限制 | 无持久 display scope 时，使用原生 captureSiteGuard 的一次性宿主发布；输入、输出双保护，不构造持久 DB 身份      | 两种消息角色的 10,500 字符正文；两次发布之间替换 child；关闭与全局 off/on 拒绝迟到结果 |

native child 的一次性结果使用 `expiresAt: 0` 标记不可保留，不写 Main 展示缓存，renderer 卸载时也不保存。
该字段只描述缓存期限；活跃视图继续遵守作用域、ticket 与输入有效性，不获得动作权限。
已知协议的 host-message 路径继续执行原有保护；未知 peer 和不可证明的路径保持保守处理。
guest 正文上限与 ModJson 配额没有增加。

## 复审时补齐的联动

缓存释放 guest 依赖 proof 后，仍可见的行不能不断重新抢占相同的 96 个缓存名额。
renderer 对这类宿主失效使用 `ownerRequired` 请求恢复真实 owner；它只选择已有受检查的显示路径，
不跳过授权、来源、发布或交互检查。其旧缓存依赖先释放，避免同时占用缓存与 owner 的订阅额度。
该视图沿用 owner 生命周期直至卸载，重挂后可以重新参与被动缓存。

同时修复真实 owner 的 named-state 变化通知：只对匹配 generation 的 site 发送
`site-invalidated:<owner>`。原生 site 抑制无 scope 的 pane 通知，不能依赖全局 `panes` 通知刷新正文。
回归验证 owner 恢复后仍收到对应状态失效、显示新值，已释放的缓存 proof 不再重复通知。

## 保留的安全和资源边界

- 所有必要的来源/授权检查继续存在；LRU 回收包含释放与通知回调，回调之后再次做完整 admission 和 row/scope 检查。
- 回收期间实际读取的依赖发生变化，拒绝签发 proof；无效或未知 drawing 不会通过回收获得证明。
- append 只保留此前已提交的保护结果；迟到的旧输入结果不能因此成为最新投影；非追加替换和 ABA 不复活旧结果。
- cache eviction 不等于权限撤销；真实配置、来源、依赖和作用域失效仍通过相应 ticket/事件撤销展示与交互。
- native child 的待发布请求纳入工作区失效集合；关闭、全局 off/on 和 manager 关闭可中止发布。
  底层 publisher 未实际返回前，原 physical lease 仍计入上限。
- 没有保存批准、callback、Client 或工具执行状态；显示恢复不重放工具、动作或业务提交。
- 保留既有缓存字节、条数、年龄和订阅额度；额度不足时仍可保守拒绝或使用原 owner 路径。

## 测试与复现

正式新增/扩展回归位于：

- `src/main/mods/v2/display-read.integration.test.ts`
- `src/main/mods/v2/named-state-projection.test.ts`
- `src/main/mods/v2/display-snapshot-cache.test.ts`
- `src/main/mods/v2/sites.test.ts`
- `src/renderer/src/lib/function-site-projection.test.ts`
- `tests/function-site-projection-lifecycle-browser.spec.ts`
- `tests/browser/function-site-projection-lifecycle.test.ts`

最后一项将真实浏览器回归接入现有 Vitest 收集，因此随 `npm test` 自动执行。
独立复现命令：

```powershell
node node_modules/tsx/dist/cli.mjs tests/function-site-projection-lifecycle-browser.spec.ts
```

本机使用 Node 22.22.2。窄回归为 6 文件、176/176 用例通过，浏览器包含六个生命周期场景。
Node/Web TypeScript 检查通过；所列 18 个源码与测试文件的正式 ESLint 检查为 0 错误、4296 警告，
其中包含已有大文件的格式警告，不表示全仓库 lint 通过。

全量 `npm test` 于 15:24–16:13（UTC+8）执行，Node 22.22.2、两个 worker，退出码 **1**：
1598 文件、16121 用例通过；9 文件、21 用例失败；16 文件、84 用例按原条件跳过。
19 项为原有 5s/10s 时限失败，另两项为 VM 初始化 `MODS_GUEST_ERROR` 和事件循环
间隔 63.88ms 超过原 30ms 门槛。运行期间曾观察到其他 Node 测试进程及高 CPU 占用，
可能影响时限，但不把所有失败一概归因为环境。

上述 9 个失败文件在不修改源码、断言或原时限的情况下，以一个 worker 分两组复验，
**102/102 用例通过**。原全量日志和失败退出码保留，分组重跑不能替代一次完整绿色运行。
两份原有源码浏览器脚本也通过：工具展示 8 场景、长消息 5 场景。
`npm run test:chat:performance` 的 8 个源码浏览器脚本退出码 0：
真实 Radix/Virtuoso 的 400 行拖动与 prepend 没有空白帧，虚拟回收保留正文和展开状态；
侧栏连续拖动的 App 重渲染为 0、释放为 1；消息溢出检查无 scrollHeight 读取；
Markdown 复用仍使用当前工作区链接、搜索、高亮、sanitizer 和复制回调。
这些 fixture 不能代表真实 Electron 全链路或整包 P95。
`npm test` 在 Vitest 失败后中断的后续 **16 组独立脚本已按原命令补跑，全部退出码 0**：
adoption、消息、Hooks、插件、任务卡、合并、workflow、桌面 Agent、IM、流程恢复、
创作预览与安装、流程文件、两类评测、Mods 界面。workflow 包含原有 66 项真实 Git 工作树测试。
这属于补充执行，不改变第一次完整 `npm test` 的退出码。

完整执行前后 4717 个源码、测试、脚本及配置文件的指纹一致：
`ab1ffda386d33b687d0e03f7f6ef26db678b42cbc6f38cdea8e96e6a88c11767`。
主要证据：`npm-test-result.json`、`npm-test-full.log`、`timeout-recheck.log`、
`remaining-recheck.log`、`browser-recheck-results.json`、`chat-performance-recheck.log`、`chain-results.json`。
过程证据保存在忽略目录 `output/mods-review-fixes-20261022/`。

## 复审结论

四项已知问题均已有修复与针对性回归，另补齐 owner 恢复后的状态通知。
复核流式追加/替换、容量淘汰/真实失效、依赖额度、native child 生命周期及 IPC 守卫，
本轮未发现新增阻断问题。该结论覆盖上述源码路径和已执行用例，不代表整体性能方案已验收。
完整统一测试仍需在资源稳定的环境取得一次退出码 0；不能沿用修复之前的绿色结果。

以上修复和复检阶段没有构建、打包、提交或推送。固定机器 P95、新安装包、升级/降级和两小时浸泡属于整体方案的后续验收，
不能由本次功能回归替代。

## 后续提交与推送范围

用户在复检后明确要求推送代码、使用详细中文备注，并指定当前开发分支。
因此将当前 `codex/mods-v2` 的源码、测试及技术文档提交并推送到同名 origin 分支。
提交包含本轮收敛实现及四项修复，也保留并一并记录该开发分支已有的高级设置统一、
内置聊天模板精确复用、配套说明和 1.5.12 版本元数据改动。
本地测试日志、临时证据和未跟踪的报告导出文件不纳入提交。
该提交不等于完整性能验收或版本发布，不新建 tag，不触发手动打包或发布。
