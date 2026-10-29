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

`revision` 满时，先调用 `{"action":"project_read","id":"my-data"}`。再调用 `project_save`，传 `id: "my-data-next"`（未占用的新草稿 ID）、`name: result.name`、`revision: 0`、`files: result.source.files`。必须逐字复制完整文件数组，不重新 scaffold，不省略 Skill、合同、Harness、runtime 或 action-lock；保留 plugin.json 名称/version、运行声明身份和公开动作锁。只变制作草稿编号，不变插件身份。按新返回 revision 继续编辑、compile、doctor/test；新草稿不继承试用，旧预览租约、原源码和正式安装版本继续保留。

`drafts` 或 `sessions` 满时，先读取已有草稿的完整源码和 directory；检查通过的版本 pack 导出 ZIP，再将源码目录完整复制到用户保存的新目录，按 CLI 路线继续。最新版本检查失败则先保存完整源码副本，在副本中修复，不把失败源码称为已通过的安装包。带动作锁的 doctor/pack 仍依赖真实授权目录，CLI 无该目录时明确告知，不能删除锁规避。其他制作聊天不会自动读取旧草稿；需显式提供完整文件集后以 revision:0 保存、重新验证。进程名额满时先保存成果并核对仍在运行/结果未知的试用，重启后需重新创建试用。inspect_plugin/read_plugin_asset 不提供完整根 JSON 配置，不能当作已安装版本完整导回创作的工具。

## 本地命令路线

已有可用 `openwork` CLI 时，新项目使用 `plugin init <新目录> --template native-modular`；旧 `project-lite` 和 `harness-lite|harness-fullstack|harness-data` 仍保留兼容。修改作者源后执行 `plugin compile <源码目录> --out <新目录>`，它校验并写入独立编译结果，不覆盖源码。对新目录再执行 `plugin doctor`、`plugin test`、`plugin dev --out`、`plugin pack --out`。开发仓库对应 `node bin/cli.js plugin ...`，需要先构建 CLI bundle。`dev` 当前准备目录，不启动服务器或模型。不要在未构建的安装版本中声称命令已存在。
