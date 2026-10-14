# Claude Mods 兼容补齐：会话状态与编码

开发目录 `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。本轮没有转到 UAT，没有提交或推送，保留原有未提交工作。

## 本轮结果

增加了 Claude 2.1.283 的一组实际兼容能力，不是全量兼容完成声明：

- `$.state.get/set`：会话内命名状态、读取快照、版本与 CAS、跨插件读取和 owner 写权限。和持久 `$.store` 分开。
- 静态 `import { atom, derive, memberOf, read, update } from "claude-code"`：默认值、shape、按实例寻址、嵌套派生缓存、最多64次CAS重试。
- 渲染读取自动订阅，成功写入使相应绘图失效，不必手动调用 `ui.invalidate`。渲染调用链禁止写入，按钮回调可以写。
- 会话值在插件运行时重载后保留；关闭 Mods、线程关闭、应用退出后释放。代码缓存和旧绘图回调随运行时销毁。
- Hooks/Client 的纯 QuickJS `TextEncoder/TextDecoder`，支持 UTF-8、encodeInto、流式 decode、fatal、BOM、BufferSource 偏移与品牌检查。非 UTF-8 编码仍明确拒绝。

三插件例子已证明实际组合效果：owner 按钮发起增量，policy hook 把写入值乘二，reader 自动显示十倍分数。计数依次2、6、14，分数20、60、140；撤销 policy 后下一次计数15、分数150。无模型请求、无手动刷新。见[示例与使用步骤](../examples/mods-reactive-state/README.md)。

## 调研与评审

依据已有独立提取的2.1.283内嵌声明和宿主实现，未复制上游实现源码进产品。Atom/Derived 行为来自已记录的 state helper 模块；状态快照依据 Hxe/mbr/gbr 的真实行为修正，不只根据类型注释推断。

[方案](mods-v4-compatibility-plan-2026-09-27.md)经两位 agent 评审：第一位要求修正读取快照生命周期，修订后通过；第二位通过并补充配额、会话隔离和编码边界验收。

最终代码也由两位检视通过。发现并修复：不存在键的订阅未计配额；初始化失败残留监听器；空状态/加载失败占会话保留槽；仅剩保留状态时关闭 Mods 漏清理。对应回归没有删除或放宽原有断言。

## 对存量用户的影响

- `FUNCTION_HOST_REVISION` 更新为 `named-state-encoding-v66`，旧授权摘要会失效，用户需要重新审核授权。这是有意的权限边界变化。
- 未使用新状态的插件不占保留状态槽。原有聊天、模型、工具权限、DIY流程继续沿用原入口。
- 新状态可在同一会话中被其他已授权插件读取，写入仍须 owner 发起；共享前后沿用内容保护。它不是隐私密钥存储。
- 不开放 Node、网络、任意包或动态 import。虚拟 `claude-code` 模块只提供五个状态 helper。

## 有界兼容和剩余项

- 每会话值最多8192条／4MiB；最多保留32个实际写入过的会话，超出时拒绝新增保留状态的写入，不阻塞旧插件或普通聊天。
- 订阅每绘图1024、每会话8192／4MiB，读取不存在键也计入；卸载、关闭和失败回收。
- 编码输入最多524288个UTF-16单元，解码输入最多1048576字节，还受VM的CPU和内存预算约束。
- 上游 PluginState 静态契约扫描、自动类型生成、完整模块导出未实现，标记 partial，不把状态 SDK 的运行支持当成开发者工具全兼容。
- `session.send`、`process.spawn`、其他标准全局对象、完整事件生产触发、终端等界面仍是后续批次。正式TTFT预算和长期内存验收仍未完成。

逐项新增与剩余边界见[增量矩阵](mods-v4-compatibility-delta-2026-09-27.json)；[旧矩阵](mods-v2-compatibility-matrix.json)继续保留历史基线，已更新编码对象可用性。未改变兼容profile来宣称2.1.283全量支持。

## 验证记录

| 范围 | 结果 |
| --- | --- |
| 本轮兼容与相关宿主回归 | 8文件166项全部通过，含最终追加的真实打包探针 |
| 全库Vitest | Node22、2workers；4893项，4862通过、26失败、5跳过；按完整测试名对比V3基线，无新增失败，无消失的历史失败 |
| 全库后追加测试 | 编码打包探针随后加入并通过上面的166项回归；不是重复跑全库后的新总数 |
| 类型检查 | Node/Web通过 |
| Lint | 本轮新增源码、测试、性能脚本以及loader检查，0 errors、0 warnings；未全文件重排历史manager/session代码 |
| 生产隔离进程 | `test:mods:function:process`通过，覆盖真实utilityProcess的Hooks/Client、编码及既有宿主能力 |
| 命名状态Electron E2E | 6条断言通过（包括默认关闭）：三插件联动、owner保护、实际运行时重载、撤权后行为变化、关闭后原输入框可用 |
| 编码Electron E2E | 5条断言通过（包括默认关闭）：SDK await前后原生向量、真实Client按钮、重载/撤权、关闭后的普通输入框 |
| 既有DIY浏览器 | 5组通过；编辑/排序/nonce审批、旧请求隔离、监听收敛、64步p95 23.4ms |
| 既有Autobiz DIY生产E2E | 7组全部通过，含真实文件修复、原生检查、步骤/模型切换、人工确认、唯一阶段提交、重启记录；模型是受控协议fixture，不是远程LLM质量评测 |
| 其他存量回归 | `test:desktop-agent-baseline`、`test:plugins`通过 |
| 构建 | E2E专用与普通生产构建通过，测试runner finally恢复普通产物 |

编码E2E首轮发现探针中的裸 `typeof require` 被esbuild改写为局部shim，导致错误推断为宿主全局暴露。改为准确检查 `globalThis.require`，仍严格要求它不存在；补充真实编译后的Hooks/Client回归，并确认动态加载`node:fs`失败。没有把隔离断言放宽为允许require，也没有因此修改产品权限。

全库26项历史失败说明继续参考[原有问题记录](mods-v2-existing-failures-confirmation-2026-09-26.md)。本轮执行的是有并发上限的全库Vitest及上述独立套件，不能表述为整个`npm test`链全部通过。

可复现入口：

```sh
npm run test:mods:compat
npm run test:mods:function:process
npm run test:mods:compat:e2e
npm run test:mods:flows
npm run test:mods:flows:browser
npm run test:mods:flows:e2e
npm run typecheck
```

使用工程要求的Node22。兼容E2E脚本在同一测试构建上顺序运行两个场景，finally恢复普通生产构建。

## 性能与证据

- UTF-8注入前后100对交替VM创建样本（另20对热身）：p95从3.1008ms到4.2860ms，增加1.1852ms。持久VM不是每次SDK调用重新创建。
- 8192条状态下，包含整个Map复制的写入p95为1.193ms；首读快照p95为0.0114ms。64轮共65536次订阅读取/释放没有耗尽存活配额。
- 最新真实点击到两个面板更新3个样本约为80–200ms；样本太少，不据此计算p95或承诺端到端性能。
- 以上都不能覆盖历史TTFT p95增量53.1ms超过40ms预算，或代替长时间内存验收。

本机产物：`output/mods-v4-validation/encoding-performance.json`、`state-performance.json`，`output/mods-validation/e2e-named-state/`、`e2e-encoding/`，全库测试及基线比较以 `output/mods-v4-*` 命名。截图随E2E保存。
