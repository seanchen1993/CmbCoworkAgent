# ui.resolve 固定原版研究与最小适配建议

本次只在 `C:/ai/CmbCoworkAgent-mods-v2` 的 `codex/mods-v2` 工作。研究未修改生产代码、已有探针、UAT 或全局 Claude CLI；只运行隔离的原版 `plugin test`。本报告给出原版证据及后续设计条件，不代表 Stage20 已实现或已验收。

## 固定产物与独立证据

正式运行是 [qualified-single.log](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-review/qualified-single.log)：**13 个独立测试、1 个文件、13 PASS / 0 FAIL**。实际原版命令返回 `2.1.289 (Claude Code)`、退出码 0。每次 runner 均重新检查 EXE、两份下载归档的 SHA512 SRI、声明/测试工具及其 manifest 对应提取资产的 SHA256；最终额外逐项核对了引用的两个可读 Bun chunk。

产物根目录：`output/claude-code-2.1.289-alignment-analysis-2026-10-04`。

| 产物 | SHA256 |
| --- | --- |
| `native/package/claude.exe` | `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b` |
| `readable/claude-code.d.ts` | `791464683ba02b5905d477fdb2fe9a81a5110c937bc28bae21414657d53a9894` |
| `readable/kit-modules.js` | `20de9e6abf0e04968db029d9a4880edc4ab45d173d315a212bd0e89dcdbff119` |
| `extracted/chunk-hgy5nkw2.js` | `45b5d53c939c416a07ab8a430360cb40e6b53d62cc40478be364f7a93a47822e` |
| `extracted/chunk-zn5xb8t9.js` | `a92196c49fccfbee6b1a90ca31d200f68e3075992730c73a82e1ab9e1d6208fe` |

两份归档 SRI：

- native：`sha512-t6PwcRoMIeuNPbnkf9bFxdUv3xBgUSnk1yRU3r8b5CjovwzV1zUY/talE4rgGAvcTwmndirtWOny/3LPf6Ju+w==`
- main：`sha512-RQWjAlalf9aomgI3JaXDCdFPvmNVnRdjwMtYk5L+Lw1NWxCxbhY5T9F+w1xukqvJh/I2rR2+3hICZxhk0al1nA==`

详细校验记录及四个输入文件 hash 在 [qualified-single-result.json](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-review/qualified-single-result.json)。正式夹具快照在 `ui-resolve-review-evidence/qualified-single-fixture`，独占 runner 为 `ui-resolve-review/run_review.py`。

`first` 至 `eighth` 的实际日志全部保留。早期失败分别涉及 TSX 文件扩展名、查询命中父 Box、manifest 路径与必需字段、testkit store mock 的注册方式；不把这些夹具失败归因于原版。`qualified.log` 曾把位于探针内部的快照再次发现为测试文件，实际同 13 个测试运行两遍，记录 26 PASS；不当作 26 个独立用例。快照随后移到兄弟证据目录，正式 `qualified-single` 只运行一个文件。

## 官方契约与实际实现依据

[官方 reference](https://code.claude.com/docs/en/plugins/mods/reference) 当前明确为 2.1.289，并说明版本不一致时以安装版本写出的声明为准。本次使用固定产物内声明，而不是从网页推导未实测行为。

- `claude-code.d.ts:2299` 附近：`$.ui.resolve(e)` 是同步读取冻结的元素构造器表，不在读取时重新 dispatch；表由加载时的 `ui.resolve` 链按 surface/component 预先产生。
- `:3674` 附近：构造器接收含 children 的 props，返回冻结的 plain-data RenderElement；JSX 调用表中的真实函数。
- `:3871` 附近：规则在插件加载时运行，输入只有 surface/component，没有父 props；读取插件自己的表时跳过其规则；省略 key 则该元素画 fragment。
- `:9882` 附近：ResolveInputOf 的两个字段是 surface/component。
- `:15145–15167`：官方测试 body 有真实测试 registrar，inline plugins 与被测插件一起加载；options 按真实 manifest userConfig 校验。仅 store 使用官方 `mock.store(on)`；本探针没有自定义下游 `ui.render` core。

可读 Bun 模块独立支持这些结论：`chunk-hgy5nkw2.js` 的 `X$t`/`qae` 在全部加载模块之间预计算表，明确排除目标模块对象，并检查 live 状态、hopKey 和 matcher；`chunk-zn5xb8t9.js` 的 `j6r` 按 surface/component 存取表、`Xf`/`_6o` 桥接真实函数并把缺席元素补为 fragment。审计定位使用字符 offset（分别约 1,745,749 和 219,000–221,300），没有把 minified 行号当精确源码位置。上述专有实现未复制进产品。

## 13 个独立原版测试

所有绘制结论使用官方 testkit 的真实 `$.ui.mount`/find/press/redraw，默认下游原生元素构造器及独立 inline 插件。JSON 只用于读取计数和事实，不代表函数表或替代 UI 证明。

| # | 真实断言 |
| --- | --- |
| 1 | 首次绘制前已经解析；读取返回同步冻结表、Text 是函数、无 Promise；自身两个 redraw 读取同一对象，原生 OWN_NATIVE 未被自身规则替换。 |
| 2 | 自身整个 resolver 插件组排除，含第二个带 matcher 的 registration；同一组确实把另一插件文本改成 NEIGHBOR:RESOLVED:OTHER_NATIVE。 |
| 3 | replacement 调用真实 lower.Text，另一插件实际 Text 节点改变且 dimColor 保留；真实 Button callback 一次执行并成功写 store。 |
| 4 | redraw 和第二 mount 复用已解析表；规则调用数不增加，真实构造器仍为每次绘制执行。 |
| 5 | 省略 Text 后无 Text 节点，但孩子内容仍在实际 Box 中；Button 保留。fragment 不是删除整棵子树。 |
| 6 | replacement Button 改变 label；真实 ui.press 的 plugin/element 仍为 actual-drawer/actual-button，原 callback/store 写入各一次。 |
| 7 | async replacement 返回 Promise 而不是同步元素，真实 mount 拒绝。 |
| 8 | replacement 产生 80 层树，真实 mount 拒绝。 |
| 9 | 同类 replacement 产生 8 层 Box，真实 Text 正常绘制且 Box 数精确为 9。 |
| 10 | 省略 Button 后无该 key、真实 press 拒绝，原 callback 计数仍为 0。 |
| 11 | resolver 抛错后，另一插件实际原生 Text 仍显示 OTHER_NATIVE，replacement 未执行。 |
| 12 | resolver 返回非函数 entry 后，同样回退真实原生 Text。 |
| 13 | 两个独立插件的函数 wrappers 实际组合，另一插件 Text 显示 INNER:RESOLVED:OTHER_NATIVE，不是 JSON 描述的重写。 |

第 7/8 项只证明这两类无效结果被真实 mount 拒绝，不推定原版所有深度/CPU阈值。第 11/12 项直接证明 resolver 的 throw/非法表保持下游原生构造器；不声称原版无任何诊断日志，也不把 ui.render 无下游实现时的拒绝误称可见 core fallback。

## 本工程最小可实施路线及通过条件

当前 `guest-ui.ts:28` 的 uiElements 在真实 draw 中现场生成固定原生表；`guest-bootstrap.ts:408` 的 SDK 直接读取它。`guest-runtime.ts:351` 和 `host-entry.ts` 的普通 invocation/result 是 JSON 协议，不能直接传函数。`runtime-client.ts:304` 已把多个持久 guest 放在同一 utility process，可在该进程内增加私有的同步构造器能力桥。跨 VM 成本属于可适配工作，不构成框架不可能的证据。

建议最小 foundation：

1. 建立私有 resolver table/函数引用 registry。函数对象和 QuickJS handles 只保留在 utility process，不把源码、函数、可执行字符串或公开数字 ID 混入普通 ModJson。主进程只决定真实 Session、已批准模块对象/次序、surface/component 与 epoch，不能由 guest 输入选择额外插件或提升 tier。
2. 在一次加载组完整注册之后，为每个消费插件和本工程实际 desktop site 预解析表；规则链跳过**该消费插件的全部 ui.resolve registrations**，按真实加载次序和 matcher 执行。SDK 同步读取同一冻结表，正常 redraw 不重新解析、不重置状态；插件组/实际 Session 退休则释放表和所有引用，不能复用旧 epoch。
3. 真实 lower table、replacement 与 wrappers 必须是可调用函数。跨 VM 参数传送需要 bounded plain-data 克隆和私有 callback 能力，保留 wrapper 闭包本地状态；不能转译成 JSON placeholder 再用 renderer 模拟执行。构造器同步调用另一 VM 的真实函数，嵌套调用有明确深度/大小/CPU限制，禁止同步等待主进程 Promise 或泵 unrelated jobs。
4. 区分函数定义的模块寿命与调用的真实 draw receipt。定义 frame 正常结束后，缓存构造器仍可调用；每次调用必须固定当前实际 UI owner、slot/Pane generation、原 signal 与原 host guard，同时核验定义模块的 grant/epoch。不能复活旧 SDK frame、捕获 ambient main fallback，或把任何函数/回调输入当作权限。constructor 内跨 SDK 的完整语义本次未探测，实施时不得据此扩大授权或声称已对齐。
5. lower.Button 接收外插件 callback 时必须保留原 callback 的私有 owner；重新标记为 resolver 插件会直接违反第 6 项原版结果。回调按既有真实 action receipt 执行，旧 generation/撤权后拒绝；下游返回的合法 opaque handles 只沿私有证明转运。返回树继续经过原内容保护、Link 归一化、provenance 及原子提交栅栏，失败不能退休旧健康 UI。
6. 非函数表、resolver throw/取消和非法 constructor 结果分开处理。普通 resolver 可恢复失败使用原 dispatcher 的下游 memo/fallback，不重跑真实 lower；撤权、dispose、host proof 失效不可转成成功 fallback。省略 key 生成 transparent fragment，并确保不给无效 action 保留 handle。

实施验收至少需要真实两个插件的 Text/Button 替换、两个 wrappers、全自身组排除、一次加载缓存与 reload 失效、缺席元素 fragment、非法表与函数结果、并行 draw、source/epoch/rebind/取消 barrier、跨 VM callback owner、晚到旧 handles 拒绝、保护后原子提交失败保留旧动作。继续保留旧 Pane/13 sites/Client 真实回归；Client 自己的 `surface.elements` 是否也经本链，必须另有原版及实际接线证据，不能从上述 `$.ui.resolve` 结果推定。

本次研究结论：**同步真实函数表替换可适配，原版基础契约证据 PASS；本工程实现尚未评审，待 Stage20 总方案及真实实现测试。** 本探针未证明 OS 桌面绘制、其他 surface 完整契约、完整 SDK 在 constructor 内行为、跨重载表迁移或精确原版最大深度。
