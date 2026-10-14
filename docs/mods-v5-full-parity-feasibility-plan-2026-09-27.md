# 完全对齐的可行性、路线与本轮验收

## 结论

“所有Claude版本、任意插件、所有客户端、权限与内部行为完全相同”不能承诺。当前Electron桌面宿主和Claude CLI的环境不同，现有项目文件边界、内容保护和资源预算也与上游有差异。保留这些差异时，不能把功能类似写成无条件100%兼容。

可行的工程目标是：固定Claude Code 2.1.283，以明确的桌面宿主profile逐项实现、对照和验收公开核心行为；不适用、主动适配和未经验证的项目必须继续列出。只有required条目全部完成对照，才能声称该范围完整。不能通过删除难项或把CLI-only改名为“不需要”来制造完成率。

本轮沿用开发目录 `C:\ai\CmbCoworkAgent-mods-v2` / `codex/mods-v2`，保留全部既有未提交工作，不改UAT。

## 证据与关键架构差距

- 固定内嵌声明：`output/claude-code-2.1.283-analysis/readable/claude-code.d.ts-8ef3f324.txt`，SHA256见V3审计。公开tag声明与内嵌声明不同，以这份版本化产物为本轮基线。
- `session.send`（声明2604、9972附近）向另一agent/session投递peer消息，成功只代表入队；必须连接真实inbox和session.receive，不能伪造用户消息或把启动turn视为投递成功。hook可重定向，但来源固定且目标必须重验。
- `process.spawn`（3152–3206）是CLI-only流；break/return/abort/unload杀进程，hook返回却不应终止仍迭代的子进程。当前guest-runtime finish会收回invocation，turn.step的stream.close又为恢复故意不关闭游标，必须先做模块资源lease和独立stream协议。
- 类型工具不是拷贝一份d.ts：需要manifest.types、PluginState/EngineInterface声明注册、依赖契约和digest、受限TS分析，以及符合本地主机实际支持范围的生成类型。
- checker当前只看事件名是否存在；classic.FileChanged等仅schema事件会得到valid:true和空诊断。这是实际使用误导，应优先修复。
- [官方Hooks参考](https://code.claude.com/docs/en/hooks)用于核对classic事件的真实触发与结果作用；它不是Function Mods SDK已全部公开或已经在本工程实现的证明。

## 全量路线与完成标准

| 阶段 | 要实现的内容 | 不能省略的验收 |
| --- | --- | --- |
| A 支持事实与检查 | 代码侧能力目录；package/registration检查和运行兼容结论分开；schema-only、provider-required、受限能力明确提示；2.1.283新增项入账 | 精确/通配/负模式、已知不可触发事件、未知插件provider、CLI退出码、存量插件不误禁用 |
| B 客体标准环境 | URL/URLSearchParams、AbortController/Signal、structuredClone、crypto/performance，补齐各自规范而非同名简化函数 | Hooks/Client、原生/WPT差分、品牌检查、不可跨VM泄露宿主对象、时间/内存上限；timer必须归属可销毁资源 |
| C 资源生命周期与宿主SDK | module-owned lease、process.run/spawn、clock.after/every、http.fetch；独立流open/pull/close/backpressure与进程树清理 | hook返回后台继续、取消/重载/撤权/崩溃、输出洪水、无shell argv、只执行一次、真实PID验证；旧turn.step不退化 |
| D 消息与业务事件 | 真实session inbox，send/receive；agent.spawn、prompt、tool/config/skill/attribution、classic生产触发逐项接入；settings/env/audio/fs.ancestors等各定契约 | 来源/目标/权限、入队与完成区别、拒绝和改写实际生效、真实生产入口E2E，不能用手动dispatch冒充 |
| E 作者工具与界面 | TS契约、类型生成、可支持的完整JSX/桌面UI；终端等其他surface单列独立实现成本 | 不提示不存在API；声明依赖/循环/重名/大小/路径/失效授权；界面结果和事件生命周期对照 |
| F 全量对照与发布 | 固定版本黑盒语义样本、逐项证据账本、跨平台安装产物、TTFT与长稳 | required无unsupported/unverified；所有主动适配仍明确列出；正式性能预算与长稳不能被微基准替代 |

B到E不会因为A中的诊断变好而自动完成。C/D需要架构增量，不能在一个SDK分支里直接绕过现有身份与取消机制。具体排期要在资源/inbox原型验证后估算，当前不编造精确工期或百分比。

## 本轮实施范围：A 与 B 的 URL 纵切

两位agent评审通过后，先落实上述可独立验收的基础，并为后续复杂SDK建立可信入口。

### A：兼容检查

- 新建shared支持目录，不在生产中读取docs历史JSON。事件维度区分有生产接入的有界支持、仅schema、无内建provider；不能把SDK.ui.resolve和同名engine事件混为一类。
- 保留既有valid字段的包/注册检查语义并加清晰字段 `packageValid`、`compatibility`，使旧调用方不被诊断升级破坏。不能让已注册事件的检查报告只有空诊断却暗示完整运行兼容。
- 精确订阅缺失能力时明确警告/不兼容；通配及负模式只报告匹配到的实际范围，不能因为匹配到一个不支持事件就判整个观察器不可用。
- 不默认拒绝现有已授权插件；未知事件有可能来自自定义engine provider，应明确“需要provider/待验证”，不假装已支持。
- 对SDK任意别名/动态属性访问不做不可靠的静态全覆盖承诺。本轮只保证实际注册和已知支持目录的诊断，声明完整性缺口继续记录。
- CLI提供显式严格兼容检查选项；正常package check行为兼容。诊断进入桌面Mods状态展示，文字解释使用影响，不以内部错误码代替说明。

### B：URL/URLSearchParams

- 使用固定版WHATWG URL实现（研究候选whatwg-url 14.2.0及锁定依赖），不手写近似解析器。不执行第三方安装脚本、不从插件加载npm包。
- 依赖代码仅在QuickJS执行，复用已有UTF8；构建时生成或打包可追溯的guest资源，保留license与版本，不把宿主URL构造器跨VM传入。打包后的Electron也必须能工作，不依赖asar内动态esbuild解析。
- 支持IDN/IPv6、relative/file/opaque URLs、可变属性、URLSearchParams双向live绑定、重复参数/排序/迭代/forEach、canParse等声明表面。Blob/object URL没有对应宿主，明确不宣称支持。
- 差分以Node22标准URL与固定输入向量为主，额外覆盖非法输入、代理字符、百分号、品牌和mutation；与Claude的所有边界完全等价仍需参考运行时对照，不能仅凭Node差分标verified-equivalent。
- 测量bootstrap冷启动和实际URL操作；维持现有VM资源边界，不能为通过样例悄悄放宽沙箱。若规范库无法满足预算，先解决初始化策略再交付。
- 更新host revision，旧授权不得隐式获得新增运行能力。

## 后续底层设计约束（尚未实现）

阶段 C 不把当前 invocation 直接延长为永久权限。新增模块资源表，资源身份至少绑定 workspace、session、plugin、source digest、grant epoch、runtime generation 和 owner module。仅在有效调用中、完成现有最终参数审批后创建资源；调用返回可让明确声明为 module-owned 的资源继续存活，但不能让失效的 `$` 任意调用其他 SDK。普通 model/tool/fs 请求仍遵守当前 invocation 的取消规则。

独立资源流使用 open/pull/close 协议，open 有宿主生成的唯一请求身份，重试不能重复创建进程；pull 必须校验 owner、generation、资源状态和序号，只允许有界待处理请求；close 幂等。输出按字节与队列长度限额，消费暂停时做背压或明确终止，不能无限积累内存。stdout/stderr chunk、终态 code/signal、异常必须保持上游可观察顺序，不能把 terminal result 混入普通 chunk。

生命周期是创建中→活跃→关闭中→关闭。停止来源包含迭代器 return/break、显式 abort、模块卸载、撤权、项目/会话销毁及宿主进程退出；同时到达只能执行一次清理。Windows 进程树采用项目已有受控 Job 机制，其他平台分别验证进程组；不能只 kill 父 PID 便声称无孤儿进程。hook 返回后的合法继续消费与 hook 取消必须有不同测试，取消中的待决 pull 必须结算，不留永久 Promise。

阶段 D 将发送与执行拆开：入队记录保留不可伪造的发送插件和会话身份，目标在 hook 重写后重新授权；事务成功才返回队列确认。接收端按会话 lease 消费真实 inbox，投递 `session.receive`，保留 peer/coordinator 来源，不伪装成用户输入。明确排队中取消、收件会话关闭、重启恢复和重复消费的契约，再接入新的 turn。跨项目投递默认不借用发送方文件权限；目标关闭、权限撤回和 hook 重写到越权目标均拒绝。

阶段 E 将“能编译”和“类型已兼容”分开：先定义宿主支持范围的声明生成源，再引入 manifest.types 的有界解析、插件命名空间、依赖顺序与冲突诊断，声明及依赖版本必须进入审批 digest。不能复制上游完整 d.ts 让编辑器提示可以调用宿主实际不存在的方法。JSX/Client 的事件、渲染及销毁测试独立验收，不用桌面外观近似代替 CLI 语义。

上述后续改造落地前，先从固定参考运行时取得最小可执行轨迹（尤其跨 hook 返回的 process 流），由两个 agent 再评审具体协议与失败路径。现有阶段 A/B 的通过不自动代表这些未实现协议已评审或验收。

## 本轮质量门槛

1. 两个agent先方案评审，有阻断先修；实现后交叉代码检视。
2. 新行为回归、Hooks/Client真实VM、utility-process和生产Electron E2E；安装→授权→使用→撤权/重载。
3. 原Autobiz DIY浏览器及7组生产E2E、桌面基线与插件回归；全库Vitest Node22/2workers，与V4 26项历史失败逐项比较。
4. 新代码lint、Node/Web typecheck、普通生产build；测试专用构建finally恢复。
5. 文档和可执行支持目录相互校验；交付报告写完成项、主动差异、未验证项和后续架构工作，不用“全绿”掩盖历史失败。

## 方案评审

- full_parity_quality：通过，无阻断；严格检查不把通配观察器整体禁用，空注册也不能称全兼容。
- full_parity_feasibility：通过，无阻断；补充生成资源可重现检查、依赖版本/license和真实VM资源预算验证。
- 两位通过后实施A与URL纵切；C–F仍为未完成路线，交付时继续列明。
