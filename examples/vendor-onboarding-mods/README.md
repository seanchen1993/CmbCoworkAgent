# 独立业务示例：供应商准入 Mods

本示例验证业务组装公共能力，不依赖 AutoBiz 的检查点、Python 内核或专用适配器。
`mods/business/manifest.json` 声明 `host-linear-v1`，通过现有业务组装服务生成原生 Host 项目。

`board_core/board_config.json` 刻意作为普通业务资料索引保留，并使用非 AutoBiz 的结构。
它引用真正随包提供的 `knowledge/admission-policy.md`，不声明 `kernel.boardConfigPath`。
文件名和目录本身不能触发旧引擎、旧 workflow 解析或权限；运行路线取决于有效协议声明。
来源 ZIP 安装、组装、检查、导出与新 ZIP 安装均应原样保留此资源，且不能出现在旧 board 入口中。

## 组合与使用

1. 从业务 Mods 组装入口选择本来源，选择「准入报告」。
   报告依赖「主体资料」，资料依赖「准入策略配置」，组装器会加入依赖，得到两阶段基础插件。
2. 要增加资质审查，再加入 `../vendor-qualification-mod` 来源，选择「资质审查」。
   按「主体资料 → 资质审查 → 准入报告」排序，生成另一个独立插件。
3. 检查、安装或导出新插件。在项目模式建立任务，通过原生配置表单选择
   `policyTier=standard` 或 `enhanced`，审核并授权当前冻结源码。
4. 提供真实供应商名称、信用标识及资料来源，逐阶段执行和确认推进。
   Skill 读取冻结知识文件，调用普通 Mods `settings` 工具取得实际配置，
   用原生文件工具生产和消费工作区 JSON；Host 根据必需 JSON Schema 检查签发回执。

用户自己的 Mod 只需声明同版本 `kernelRef`、真实 Skill、资源、依赖、输入输出及
`host` 阶段/检查，不需要修改平台或编写供应商专用平台判断。不能把别人的检查结果文本
当作宿主回执。修改已检查的产物后，旧回执不能用于阶段推进。

## 范围

`tests/project-contract.json` 是作者显式提供的隔离结构检查样例，运行在临时目录，
不会作为真实项目资料或宿主业务回执。它不能证明 Skill 或真实业务已经运行。

这是隔离资料和技术机制示例，不验证真实企业资质、不接外部准入服务、不作业务审批。
报告固定为 `needs-human-review`。JSON Schema 检查只能保证声明的结构和有限约束，
不能自动判断跨文件业务语义或资料真实性。更强策略应由插件声明真实检查动作，
并由宿主按现有动作身份、权限和回执协议执行。

`src/main/plugins/business-mod-host-independent.integration.test.ts` 覆盖公共服务、两种组合、
导出、实际 SQLite/快照、失败阻断及回执失效，使用受控 Skill 回调。
`tests/business-mod-host-independent-packaged-e2e.spec.ts` 单独验证实际包的 IPC、SDK、Skill、
Hooks、配置、知识、原生工具和下游消费。它需显式选择新构建的包；不能把未运行脚本
当作已经验收，也不覆盖阶段快照回退等暂缓的 S6 能力。
