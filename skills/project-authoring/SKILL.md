---
name: project-authoring
description: 在用户明确要制作项目插件、轻量文档流程、全栈开发或数据开发的 Harness 节点，或复用已安装公开动作时使用。通过节点定义与 Skills 创建独立项目包，检查、准备试用并打包；不代替用户安装、审批或开始业务。
---

本技能与当前 DevClaw 的 `devclaw.project-runtime/v1`、`mod_authoring` 项目动作一同交付。不要把互联网上的新 API 当作当前版本已支持的能力。

## 从自然语言创建

例如用户说：“帮我做一个起草和确认两个阶段的文档项目。”先确认目标和必要的产物要求，不要求企业编码、系统 ID、Python 或外部服务。

1. 当前创作会话提供 `mod_authoring` 后，调用 `project_scaffold`，传入小写连字符 `id`、`name` 和 `template:"native-modular"`。新项目优先使用原生可组合模块，用户无需选择内部模板。不传 template 的旧 `project-lite` 和显式 `harness-*` 仅保留兼容；不要在新插件里混用三种源码格式。没有该工具时，指导用户在当前聊天选择“创造者模式”；不要覆盖应用安装目录。
2. 返回值包含 `revision` 和完整 `source.files`。原生项目按真实示例修改 `composition/source.json` 和 `skills/*/SKILL.md`，声明各模块的输入、产物、校验及前序引用；已有原生草稿优先 `project_patch`，它保留未修改的资源。使用 `project_save` 时必须传完整快照。随后调用 `project_compile(id,revision)`，由宿主生成运行声明并执行隔离产物校验，使用返回的新 revision。不要手写或删除生成的 runtime、动作锁和知识配置以绕过错误；不要加入 `devclaw.harness.json`。显式选择的兼容 Harness 项目继续编辑其节点定义并编译，旧 `project-lite` 无须 compile。保存和编译都不会替换正式插件或正在运行的版本。
3. 调用 `project_doctor`。根据实际诊断修复；需要重新读取时用 `project_read`，避免使用旧 revision。
4. 调用 `project_test`。这会在新临时目录写入样例产物，使用生产宿主的文件存在性和受限 JSON Schema 校验器。它不调用模型、不执行 Skill 或插件脚本，也不批准阶段。故意缺文件、JSON 不合格的样例应该被拒绝。
5. 失败后修改真实节点定义、Skill 或合同，再次 `project_save`；Harness 节点变更需 `project_compile`，随后 `project_doctor`、`project_test`。不要改期望结果来掩盖未修复的缺陷。
6. 使用用户已给的真实目标调用 `project_request_trial(id,revision,goal)`，准备当前创作聊天里的原生试用卡后结束本轮，等待用户确认。由原项目运行器执行阶段、检查实际产物和请求必要确认。`project_dev` 仅准备目录，不能代替试用，更不能把 prepared 当作成功。
7. 用户从试用卡核对阶段和验收结果后，可直接“保存插件”，由原生入口核对名称、版本并安装，再“开始使用”进入普通项目模式；不要求先导出再导入。需要文件交付时 `project_pack` 生成 ZIP 和检查范围报告。模型没有安装、审批或推进工具，不得声称编译、打包或候选准备等于业务执行成功。

文件存在只能证明存在；JSON 结构符合只能证明所检查的结构。模型自述不构成阶段通过证据。`plugin.id` 是作者包标识，`installedPluginId` 是安装后宿主分配的身份，不要填写假 UUID。

原生组合的 `modules[].checks[].kind` 仅支持 `json-schema` 和 `action`，不要发明 `text-nonempty` 等类型。用户未限定文件格式时，可沿模板用 JSON 对象承载文本，通过必需字段和 `minLength` 检查非空；业务事实仍需真实复核。用户明确要求文本文件或其他校验时，发现或制作真实校验动作并绑定其契约，不能静默改格式或删除必要检查。`sourcePatch` 每次最多 16 项；新建小项目可完整保存源码，较大调整按完整模块替换组织，不能通过猜版本拆开不完整依赖。

## 兼容 Harness 的节点定义

`devclaw.harness.json` 仅描述按顺序运行的节点，不新增执行器或任意脚本字段：

```json
{
  "apiVersion": "devclaw.harness/v1",
  "nodes": [{
    "id": "draft",
    "title": "起草",
    "skill": "skills/draft/SKILL.md",
    "artifacts": [{ "id": "draft", "path": "draft.md", "example": "# 隔离测试样例\n" }],
    "approval": "human"
  }]
}
```

每个节点需要真实且含 name frontmatter 的 Skill、至少一个必需产物。产物可带宿主支持的对象根 JSON `schema`，此时 `example` 必须是通过该 schema 的 JSON 文本。example 只供隔离合同使用，不是实际工作区产物，不得含真实凭据或敏感业务数据。人工确认使用 `approval: "human"`，否则为 `"none"`。最多 8 个节点、每节点 8 个产物，生成合同总案例不超过 32；标识与产物路径不得重复或越界。

编译为每个产物生成单独缺失的失败案例，并为每个节点生成全部产物存在的通过案例。公开动作仍经下述原绑定工具附加；编译保留有效绑定，但拒绝删除已绑定节点或破坏前序输入引用。全栈/数据模板的报告与结构检查不代表代码、数据质量或部署已经通过，需要在 Skill 中执行实际验证并记录范围。不复制 UAT/AutoBiz 等原业务 hooks。

## 复用公开步骤

完整代码示例为 `examples/project-public-action-provider`，它导出公开 `format` 动作，输入 `{ "text": "..." }`，输出包含 `text`。普通命令/动作仍使用原 `scaffold`、`save`、`check`、`request_trial` 和用户安装流程；不要把项目包交给只接受纯 Function 的旧试用路径。

1. 调用 `project_actions` 列举真实已安装且已授权的公开动作。返回输入、配置和输出 schema；有 `nextCursor` 时用 `cursor` 继续。目录为空时请用户经原插件入口安装和授权，不能替用户批准或伪造条目。
2. 按用户目标选择提供者，逐字使用目录条目的 `pluginId`、`plugin`、`digest`、`actionId` 组成 `provider`。调用 `project_bind_action`，传入草稿 `id`、最新 `revision`、目标 `stageId`、草稿内唯一 `localActionId`、`provider` 和 `actionInput`。工具会再次读取目录，用真实 command/schema 写入动作锁，并返回新 revision。
3. 常量示例：选择目录中的 `format` 动作，向 `review` 阶段绑定 `localActionId: "format-note"`，`actionInput: {"text":"需要整理的文字"}`。提供者身份来自上一步实际结果，不得在示例里编造 UUID 或摘要。
4. 复用前一个动作的输出：第二次绑定 `localActionId: "format-again"`，`actionInput: {}`，`inputFrom: {"kind":"action","actionId":"format-note","pointer":""}`。只能引用同阶段已在前面的动作，且它必须声明对象输出 schema。实际输出由原 Flow 链校验和传递，不由模型声称已经生成。
5. 读取产物对象时，使用 `inputFrom: {"kind":"artifact","artifactId":"已有产物ID","pointer":"/payload"}`。该产物必须已在前序阶段声明且实际包含 JSON 对象；普通 `draft.md` 不是 JSON 输入。仅支持 JSON pointer，不接受表达式、脚本或任意文件路径。`actionInput` 常量覆盖映射对象的同名字段，应向用户说明覆盖值。
6. 保存后用新 revision 再执行 `project_doctor`、`project_test`、`project_pack`。这些动作会核对当前目录和版本锁，但隔离测试仍只验证产物，不执行提供者。绑定不代表执行成功；实际执行由用户在项目入口开始阶段，并经过原授权、审批和检查链。

`actionConfig` 用于公开动作声明的配置对象，不得猜测配置 schema 或读取本地凭据填充它。绑定多个动作会保留已有锁条目；更改绑定时用 `project_read` 和 `project_save` 明确修改完整草稿，随后重新检查。不得复制或 import 提供者内部源码。宿主报告目录或动作桥未注册时明确说明阻塞点，不能用直接脚本执行替代原链。

输入缺必填字段、动作版本变化或依赖缺失时停止运行并展示诊断。代码回退不代表撤销业务产物或外部操作。

## 达到创作限额时接续

每草稿最多 8 个版本，scaffold/save/compile/bind_action 都消耗版本；每制作会话最多 4 个草稿，本次进程最多 16 个制作会话。`PROJECT_DRAFT_LIMIT` 的 `limit` 字段区分 `revision`、`drafts`、`sessions`，按返回 hint 处理，不能反复重试同一保存或声称换聊天自动恢复。

用户只需说“继续修改”“对比上一版”或“这次修改会影响谁”。草稿编号、修订、摘要和分页由创造者依据工具返回值处理，不要求用户手动抄文件或理解内部字段。

`revision` 满时，先 `project_read(id)` 核对真实 revision 和 source.digest/sourceDigest，再 `project_continue(id,revision,sourceDigest,newId)`。宿主从最新不可变源码精确复制到未占用的新草稿，从修订 1 继续；不需要重抄 files、不重新 scaffold。插件名称/version、原运行声明、公开动作锁、Skills、Hooks、知识、配置声明和资源闭包保留。新草稿不继承试用、权限或业务通过，旧源码、运行中的预览和正式版本不变；按返回 revision 继续修改、编译、doctor/test，再明确请求新试用。失败先核对实际源和状态，不猜修订重放。

`project_versions(id)` 列出真正保留的版本、源码摘要和续作来源；旧存储只有最近版本时会明确 historyComplete:false，不能声称已恢复不存在的历史。`project_compare(id,revision,otherRevision,otherId?)` 返回变更文件索引，按 nextCursor 继续；需要正文时再提供 assetPath 和 cursor，读取两版本对应字符窗口。窗口不等于完整文件或对齐的行补丁，不把一页结果当完整源码保存。可以跨原稿和续作草稿比较；摘要一致仍不代表运行效果相同。

4 个活跃草稿槽位满时，先 `project_list` 核对状态，显式 `project_archive(id,revision,sourceDigest)` 归档不在试用的旧草稿，释放一个槽位。归档保留源码历史，可比较、从最新版本再次 project_continue；原 ID 不可作为新草稿重用。仅准备或待确认、正在运行、结果未核对的试用不能归档。已完成或明确失败/取消的试用，只有原 Host 日志身份和终态可核对、没有在用租约时才可归档；保留试用引用和项目证据，不取消、不释放或重建执行权。旧版本缺少绑定或记录截断时保守拒绝，不得为了腾槽位停止真实运行或隐藏未知结果。历史最多 16 个草稿身份，活跃源码与去重历史共同受原 2 MiB 存储预算限制，不提高限额、不自动淘汰版本。

公共 Mod 修改前使用 `dependency_impact(name或pluginId,cursor?)` 核对实际已安装插件与当前聊天候选中的声明依赖，继续读取 nextCursor 并单独处理读取失败项。保存原生卡片也显示宿主核对出的已知依赖及覆盖限制。输出没有包含任意动态 JavaScript 引用、其他聊天和所有既有项目的完整依赖图，不能以零匹配承诺无影响。固定旧摘要的调用方不会默默切到新版本，须重新绑定和真实验证；不自动改写调用方或扩大授权。

历史存储或制作进程容量满时，停止机械重试；归档只释放活跃草稿槽位，不释放历史字节或制作会话名额。先保留当前成果：已有活跃草稿可读取完整源码与 directory；检查通过再 pack 导出 ZIP，并保存源码目录副本，按 CLI 路线继续。检查失败不能称为可安装或已通过。其他聊天不自动读取旧草稿；转移须显式提供完整文件集并重新验证，不恢复试用和授权。带动作锁的 doctor/pack 仍依赖真实授权目录；缺少时明确说明，不能删除锁规避。inspect_plugin/read_plugin_asset 不提供已安装版本的完整根 JSON 导回。

## 本地命令路线

已有可用 `openwork` CLI 时，新项目使用 `plugin init <新目录> --template native-modular`；旧 `project-lite` 和 `harness-lite|harness-fullstack|harness-data` 仍保留兼容。修改作者源后执行 `plugin compile <源码目录> --out <新目录>`，它校验并写入独立编译结果，不覆盖源码。对新目录再执行 `plugin doctor`、`plugin test`、`plugin dev --out`、`plugin pack --out`。开发仓库对应 `node bin/cli.js plugin ...`，需要先构建 CLI bundle。`dev` 当前准备目录，不启动服务器或模型。不要在未构建的安装版本中声称命令已存在。
