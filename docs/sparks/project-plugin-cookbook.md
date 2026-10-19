# 只写技能和节点，制作自己的项目插件

想先使用已有模板，参阅[内置功能与项目任务](project-platform.md)。[返回概览](README.md)。

本教程对应当前项目 CLI、对话制作工具和应用内本地项目入口。下面的样例检查不替代业务测试、人工确认或实际项目验收。已有 AutoBiz 插件仍使用自己的 Hooks 和阶段规则，无需因新脚手架重写。

## 新开发者从这里开始

在“自己制作”的聊天中输入：

> 用数据开发模板帮我做一个项目插件：先定义数据口径，再编写转换 SQL，最后检查数据质量。请生成技能和节点定义，检查并准备隔离试用，不要替我安装、审批或上传。

助手使用 `project_scaffold`，选择 `template: "harness-data"`。另有 `harness-lite`（起草、复核）、`harness-fullstack`（需求、实现、验收）可选。模板提供的是开发起点，业务逻辑由你和助手补充，不是已经完成的全栈产品。

源码仓库也提供已经生成的 `examples/project-harness-data` 和 `examples/project-harness-fullstack`，可对照各自的节点、技能和样例检查；不要在真实业务目录中直接试跑示例。

第一次可用 `harness-lite` 练习：起草节点生成 `draft.md`；复核节点读取并保留它，把修订版写入新的 `reviewed.md`，再写 `review.json` 记录结论。即使没有修改，也要保存复核版本。两份复核成果都通过检查后才可完成任务；不能覆盖前序草稿，否则前序输入保护会拒绝本次执行。

你主要维护两个地方：`skills/<名称>/SKILL.md` 写“这一阶段怎样做”；`devclaw.harness.json` 写“有哪些节点、需要什么成果、怎样检查、是否要人工确认”。`plugin.json` 保留插件名称和版本。底层状态、运行记录、阶段切换、审批、隔离试用由应用负责。

例如，一个可复用的检查节点：

```json
{
  "apiVersion": "devclaw.harness/v1",
  "nodes": [{
    "id": "verify",
    "title": "检查数据成果",
    "skill": "skills/verify/SKILL.md",
    "approval": "human",
    "artifacts": [{
      "id": "quality",
      "path": "quality.json",
      "example": "{\"checked\":true,\"summary\":\"示例检查结果\"}",
      "schema": {
        "type": "object",
        "required": ["checked", "summary"],
        "properties": {
          "checked": {"const": true},
          "summary": {"type": "string", "minLength": 1}
        }
      }
    }]
  }]
}
```

对应技能必须包含标准 frontmatter，例如 `name: my-data-verify` 和 `description`，正文说明真正的校验步骤、输入、输出和失败处理。`example` 是隔离测试数据，不会复制进用户项目来冒充完成。节点按数组顺序运行，最多 8 个；每节点最多 8 个产物，合计生成的合同样例不超过 32 个。不同节点的产物 ID 和路径不能重复。

修改节点后，对话中请助手执行 `project_compile`，再检查、试用；它生成新版本，不改已经运行的项目。使用命令行时：

```text
openwork plugin init ./my-data --template harness-data --id my-data --name 我的数据开发流程
openwork plugin compile ./my-data --out ./my-data-compiled
openwork plugin doctor ./my-data-compiled
openwork plugin test ./my-data-compiled
openwork plugin dev ./my-data-compiled --out ./my-data-preview
openwork plugin pack ./my-data-compiled --out ./my-data.zip
```

`compile` 自动生成 `devclaw.project-runtime.json` 和 `tests/project-contract.json`，并实际运行缺失产物/通过样例；输出到新目录。已有公开动作绑定会保留；删除已绑定动作的节点会报错，需要先处理依赖。重新编译会重建生成的合同文件，额外的业务回归应放在你的独立测试中。

复用旧节点有两种方式：自己拥有的 Skill 可复制到新包并在节点中引用（同一 Skill 也可服务多个节点，产物分别声明）；其他插件提供的公开动作按本文“复用别人的公开动作”接入，保留版本、授权及输入输出约束。不要复制 AutoBiz 内部脚本后跳过它的 Hooks，也不要把旧项目状态直接交给新脚手架。

## 保存经验，再用于另一个项目

1. 在本地任务中完成一次阶段检查，打开“成果与经验”。
2. 选择已通过的成果，填写名称和结论，点“保存为经验”。应用保留当时的文件副本和来源；工作区文件之后发生变化，不会改写这份经验。
3. 点经验名称可以查看文件。选择另一个本地任务，点“加入所选任务的经验”。这会复制参考资料，不会推进目标任务的阶段。
4. 目标任务下次开始阶段时，助手参考最近 3 份经验、最多 8,000 字符。截断摘要不代表完整知识库；本次成果仍须重新检查。已有普通聊天不会自动加入这些资料。

保存提示“成果有变化”时，先在阶段入口重新检查当前文件，再保存；不要拿旧的通过记录当作现在的证据。每项目最多保留 50 份，详情里可明确移除本机副本，不影响原文件、其他任务的副本或已上传文件。

## 把成果交付给 TestAgent 风格的接收服务

1. 在“成果与经验”选择已通过的成果，填写名称，点“准备交付”。这一步只保存本地副本。
2. 点交付名称，核对文件。填写团队提供的 HTTPS 上传地址及目录，例如 `my-project/DEV/Features/feature-1`。
3. 勾选确认后点“确认发送”。应用逐个发送 `path` + `file` 的 multipart 请求；收到 HTTP 200 才记为接收方确认。最后发送 `DEVCLAW_ARTIFACT_CATALOG.json`，包含文件摘要和阶段来源。
4. 发送失败时查看逐文件结果。断线可能发生在接收方已落盘之后，因此“结果需要核对”不是“肯定没收到”。先核对接收方，再重新勾选发送；已经确认的文件不重复发送，未确认文件或目录清单可能覆盖同名文件。

单文件不超过 5 MB、每份合计不超过 16 MB；不保存凭据路径、不跟随链接、不自动重试、不跟随上传重定向。地址确认后固定在这份交付里；更换地址应重新准备交付。试用项目不能对外发送。这里实现通用文件交付协议，企业登录、专用字段/目录规则及原 AutoBiz 的 `ARTIFACT_CATALOG.json` 业务格式仍走原插件，不能把通用成功提示当作企业 TestAgent 业务验收。发送不会自动提交或推进阶段。

## 平台做什么，插件作者做什么

| 能力 | 平台提供 | 作者负责 |
| --- | --- | --- |
| 项目模式和节点状态 | 状态保存、固定版本、运行过程、停止与结果核对 | 节点顺序、Skill、成果声明 |
| 验证和人工确认 | 原 Skill/Hook 链、文件/结构检查、明确阶段推进 | 实际业务测试和质量标准，不伪造 `checked` |
| 知识沉淀 | 保存检查过的副本、跨任务复用、有限摘要参考 | 写出经验的适用场景、判断是否仍有效 |
| 产物交付 | 固定快照、逐文件结果、明确重试、目录清单 | 合规接收服务、企业认证和专用业务适配 |
| 节点复用 | Skill 引用、公开动作的版本与数据绑定 | 业务语义匹配、必要输入和输出 |

通用 Hooks 不需要每个新插件再复制一套状态机；它们仍通过宿主原生命周期执行。旧插件可继续保留原有钩子和验证链。新的精简脚手架有意不打包任意脚本；复杂企业插件使用原插件/旧适配路径，不能在编译时报忽略脚本后宣称完全迁移。

## 用一句话开始

进入灵件“自己制作”，开启当前聊天的制作功能，输入：

> 帮我制作一个文档项目：先起草 draft.md，再复核并生成 review.json，最后由我确认。

项目制作 Skill 会使用 `project_scaffold` 生成包，按需求通过 `project_save` 修改完整文件集，调用 `project_doctor` 和 `project_test`。修正诊断后再次检查，不需要自己编写 Electron、IPC、数据库或看板。

`project_dev` 返回独立包目录和空工作区，状态是“已准备”，尚未执行。同一开发会话保存新版后，空闲时更新开发候选；正在试用时排队保留，当前试用仍使用创建时的完整版本。`project_pack` 返回真实 ZIP 路径；通过原插件页面导入该 ZIP，再在宿主项目入口选择它。模型不会自动安装、代批或直接改阶段状态。每次修改生成新 revision，旧源码版本保留；草稿按原聊天持久保存，重要成果也应打包留存。

## 在应用中试用项目草稿

1. 保持制作模式开启，打开“在独立项目中试用”。项目草稿保存后列表会更新，也可点“刷新项目草稿”。
2. 填写本次试用目标，核对源码版本与隔离目录，勾选确认后点“创建试用项目（稍后开始任务）”。尚未准备目录时，应用会新建独立目录。创建不会调用模型，也不把草稿加入全局插件目录。
3. 在打开的试用项目中点“开始当前阶段”。沿用原 Skill、文件修改确认、产物检查和阶段审批；需要公开动作时，先在该隔离工作目录的普通聊天按原入口授权真实提供者。
4. 让制作助手修正源码。页面会显示新候选等待试用结束；运行中的 Skill 和已创建项目不会混入新源码。完成整个试用，或在所有步骤已停止且结果明确后点“结束本次试用”，才会切换开发候选。随后明确创建新试用项目，不会自动重跑。
5. 满意后让助手打包，通过原插件入口正式导入。试用不覆盖同名正式插件，也不向普通聊天增加 Hooks 或 Skills。

源码版本、目录或目标变化后，原确认会失效，需要重新核对。检查失败的新版不会替换当前候选；修正后重新保存或准备。应用重启后，可在原聊天点击“核对并恢复原试用”，由宿主核对保留的源码、原项目和当前作用域。恢复本身不执行阶段，也不恢复旧批准；此前尚未执行的任务须重新准备与确认。结果不确定的操作保留占有，必须先核对，不因结束制作、关闭窗口或重新准备而自动重放。每次新建试用使用新的空工作目录，保留上次试用产物。

## 本地作者路线

### 编辑次数达到上限，怎样接着做

每个草稿最多保留 8 个版本；创建、保存、编译、绑定公开动作都会产生版本。每个制作会话最多 4 个草稿，本次应用进程最多 16 个制作会话。达到限额不会删除源码、替换已安装插件或切换正在运行的试用。

单个草稿达到 8 版时，可以对助手说：

> 读取 my-data 的完整源码，以 my-data-next 作为新的制作草稿继续。逐字复制全部文件，保留原插件名称、版本和公开动作锁，不替换旧试用。

实际工具步骤如下（`files` 必须填入读取结果的完整数组，不能省略文件）：

1. `mod_authoring` 输入 `{"action":"project_read","id":"my-data"}`，取得 `result.source.files` 和 `result.name`。
2. 调用 `project_save`，输入 `id: "my-data-next"`、`revision: 0`、原 `name`，以及上一步完整的 `files: result.source.files`。这里的新 ID 只是制作草稿编号，**不修改文件里的插件身份**；`plugin.json` 名称和版本、运行声明、合同与 `devclaw.project-actions.lock.json` 全部保留。
3. 后续修改使用新草稿返回的 revision；Harness 节点修改后执行 `project_compile`，再 doctor/test。新草稿没有继承旧试用的授权或运行状态，需明确新建隔离试用。旧试用继续固定原版本。

4 个草稿槽位或 16 个制作会话名额已满时，已有草稿仍可读取、检查、打包。先 `project_read` 核对源码目录；检查通过的版本用 `project_pack` 导出 ZIP，同时把返回的源码目录完整复制到自己保存的新目录，再按下面的 CLI 路线编辑/编译。若最新版本尚未通过检查，先保存源码副本，在副本里修复；不要把失败版本称为可安装包。含公开动作依赖的检查与打包仍需要制作会话中的真实授权目录，CLI 不会绕过它。

重启后使用原聊天的 `project_list` 读取已持久保存的源码草稿；这不等于恢复试用授权或开始执行。确需在另一个已开启制作功能的聊天接续时，必须重新提供保存的**完整源码文件集**，以新草稿 `revision: 0` 保存并重新检查；不能只报旧草稿编号或安装 UUID。进程总名额满时先保存成果并核对所有试用，再重启；旧试用授权会过期。已安装插件的“读取原插件素材”仅供适配参考，不能完整导回 Harness 和动作锁。

在包含本轮代码的构建中使用：

```text
openwork plugin init ./my-docs --template project-lite --id my-docs --name 我的文档流程
openwork plugin doctor ./my-docs
openwork plugin test ./my-docs
openwork plugin dev ./my-docs --out ./my-docs-preview
openwork plugin pack ./my-docs --out ./my-docs-0.1.0.zip
```

源码开发环境先构建，再将 `openwork` 替换为 `node bin/cli.js`。输出目录和 ZIP 必须不存在，工具不会覆盖它们。`init --template command` 复用既有普通命令模板；它后续使用原 `check`/`inspect`/`types`，不使用轻量项目 doctor。`legacy-adapter` 模板尚未提供，不能把上述命令当作复杂插件自动转换器。

生成的四个作者文件：

| 文件                           | 作者维护内容                     |
| ------------------------------ | -------------------------------- |
| `plugin.json`                  | 包名、版本、说明                 |
| `devclaw.project-runtime.json` | 两个阶段、产物、检查和人工确认   |
| `skills/draft/SKILL.md`        | 模型实际如何起草和复核           |
| `tests/project-contract.json`  | 缺失、通过、不合格和修复后的样例 |

`plugin.json` 的 `name`、`version` 与运行声明 `plugin.id`、`plugin.version` 必须一致。它们不是安装 UUID；宿主安装时产生独立身份。轻量项目不要求 Python、企业项目编码、系统 ID、发布单元或企业登录。

## 一次失败、定位、修复和再验证

生成包默认有四个隔离样例：缺草稿应失败；草稿存在应通过；复核 JSON 缺 summary 或 checked 为 false 应失败；结构完整应通过。

将 `review-schema` 的 schema 写入当前不支持的 `pattern`，执行 doctor，会得到 `PROJECT_SCHEMA_UNSUPPORTED`。改为受支持的 `minLength`/`maxLength` 等规则，再运行 doctor 和 test。不要为了让测试通过删除所需校验或把失败期望改成成功。

`file-exists` 接受空文件，只证明文件存在。受限 JSON Schema 支持对象、字段、required、长度/数值范围、枚举、组合和本地引用；不解析远程引用，也不执行 pattern/format 扩展。复核内容是否合理仍由业务检查和用户决定。

dev 保留检查过的不可变源文件快照，保存源码通过空闲候选切换提供新版，不改写旧快照或正式安装版本。模型执行和审批由上述明确试用入口发起；CLI 的 dev 命令仍仅准备目录，不启动应用中的模型任务。

## 复用别人的公开动作

仓库的 `examples/project-public-action-provider` 是独立普通灵件包，公开导出 `format`，接受 `{ "text": "待整理文字" }`，返回 `{ "text": "整理结果：..." }`。先经既有 Function 检查/试用和正式安装流程安装它。项目作者只引用该公开动作，不复制提供者的内部文件。

在制作会话里可以说：“把已安装的公开整理文字动作接到文档项目的检查阶段，再将它的结果交给同一动作处理一次。”工具按以下步骤接线：

1. `project_actions` 返回当前真实已安装且授权的动作和 schema，分页使用返回的 `nextCursor`。没有条目时由用户安装、授权；工具不能授予权限。
2. `project_bind_action` 使用最新草稿 `id`、`revision`，选择 `stageId: "review"`、`localActionId: "format-note"`。`provider` 完整复制目录返回的四个身份字段，`actionInput` 为 `{ "text": "需要整理的文字" }`。不要复制示意 UUID 或猜测摘要。
3. 用返回的新 revision 再绑定 `localActionId: "format-again"`，`actionInput: {}`，`inputFrom: {"kind":"action","actionId":"format-note","pointer":""}`。同阶段只能引用前序动作声明的对象输出；运行时复用原 Flow 的输出映射和 schema 检查。
4. 再执行 `project_doctor`、`project_test`、`project_pack`。目录或摘要变化会导致诊断失败，不能自动转到同名新版本。安装后仍需从项目入口实际执行目标，并查看动作结果、宿主产物检查和阶段确认。

`devclaw.project-actions.lock.json` 保存真实身份、command、输入/配置/输出 schema、常量和映射。`actionConfig` 按公开配置 schema 填写，不读取本地凭据。绑定不会复制提供者内部代码，不执行动作，也不会新增授权。

授权跟随工作目录。制作聊天能看到某个动作，不代表新的试用目录或正式成果目录已授权它。先在目标工作目录对应的普通聊天，打开原“添加功能”入口，确认已安装提供者的版本并完成原授权，再从本地任务入口开始阶段。不要为解决依赖缺失而改成全局绕过权限。

执行后，在本地任务的“检查结果与历史”找到对应步骤，点击“查看公开动作结果”。这里显示保存的动作输出、锁定提供者摘要和创建任务时的数据结构；不自动重跑。如果当前目录授权撤销或提供者版本变化，输出会隐藏并提示恢复原授权或版本。历史通过不代表现在可以执行，也不证明文件仍有效。

若前序阶段已经生成 JSON 产物，例如声明 ID 为 `payload` 的文件内容是 `{"payload":{"text":"待整理文字"}}`，可以使用 `inputFrom: {"kind":"artifact","artifactId":"payload","pointer":"/payload"}`。该产物应有前序阶段的真实检查。当前阶段刚生成的文件不作为映射输入；普通 Markdown 也不能充当 JSON 对象。常量会覆盖映射结果的同名字段，空 pointer 选择整个对象。缺字段、非对象、版本变化、敏感路径或超限都会拒绝；不支持表达式求值。

CLI 没有当前会话的已授权动作目录，因此带动作依赖的包请通过制作会话检查和打包。宿主报告动作服务未注册时应准确呈现限制，不以脚本绕过。隔离测试通过不代表提供者、模型或审批链已执行成功。

### 必需上下文和业务检查

新项目协议可将必需上下文声明为 `context.provider: {"actionId":"load-context","operations":["session-context"]}`。该动作必须出现在项目动作声明和锁文件中，沿用真实提供者、原授权及原 Flow 执行；输出必须明确提供 `text` 字符串。宿主将实际取得的必需上下文接入阶段及子任务的请求，普通提示词变换不能将其删除。此形式与兼容适配器的 `entry` 形式互斥，不能用任意脚本替代未声明的提供者。

`checks.kind: "action"` 的业务检查必须绑定所检查产物的完整内容：动作输入使用 `inputFrom: {"kind":"artifact","artifactId":"目标产物ID","pointer":""}`。`format` 可为 `json`（默认）或 `text`；文本输入为 `{ "content": "实际文件正文" }`。检查输入中的常量不能覆盖真实产物字段。宿主核对原执行器保存的实际结果，不将界面展示的“通过”或普通 Hook 改写后的结果当作必需检查的凭据。

配置、知识内容、规则或产物变化会使原检查凭据失效，需要重新核对或检查。旧通过记录继续保留，但不能据此推进新版本任务。动作失败、缺少必需上下文或结果不明时，不会自动继续下一阶段。

## 打包与实际支持范围

### 让插件出现在“项目能力”中

在插件根目录添加 `devclaw.capabilities.json`，列出允许独立使用的技能或完整流程：

```json
{
  "apiVersion": "devclaw.capabilities/v1",
  "capabilities": [
    {
      "id": "document-review",
      "title": "检查文档",
      "kind": "skill",
      "usage": "project",
      "entry": "skills/document-review/SKILL.md"
    }
  ]
}
```

`entry` 指向包内已有文件。`usage` 可选 `universal`（普通聊天与项目均适用）、`chat` 或 `project`；完整流程只用 `project`。此声明不改变原技能、Hooks 或工具权限。

完整流程将 `kind` 改为 `flow`，`entry` 指向 `devclaw.project-runtime.json`。需要接收前一个流程的文件时，可在该条目添加：

```json
"inputs": [
  { "id": "document", "title": "待审核文档", "path": "incoming/document.md", "required": true }
]
```

用户选择上一步的文档后，平台检查文件并放到本流程的 `incoming/document.md`。技能按这个路径读取，不依赖另一个插件的内部目录。流程结果使用原运行声明中的 `artifacts`。

独立技能可用 `dependsOn` 引用同包其他能力，预览时会列出一并加入的内容。`requiredHooks` 用于声明必须存在的检查，未列出的原 Hooks 仍会保留；`requiredMcpServers` 列出所需连接工具的配置名称。不能通过把这些列表留空来删除原项目的验证链。

原工作流阶段不能仅凭一个独立技能声明脱离阶段验证。旧插件只有已适配的具体版本才能作为完整流程使用，添加声明本身不会开放执行。当前 AutoBiz 适配仅在 Windows 提供；修改原脚本或检查命令的版本需重新适配，不可用时继续原项目入口。发布前应从“项目能力”实际完成选择、预览、应用、执行和结果检查。

项目包可以同时包含 Skill、Mods 和 MCP。包内 Mods 沿用原编译器及逐项授权；试用卡中的“确认本包灵件权限”仅授权当前项目、固定源码及隔离工作目录，不为同工作区普通聊天替换授权。MCP 使用 `.mcp.json`，通过 `${CLAUDE_PLUGIN_ROOT}` 引用固定包内资源；不得写死作者机器目录。运行只加载本次保留的包，不回落到已变化的安装目录。

pack 使用普通插件 ZIP 格式，并附带版本、源码摘要、文件清单、排除项、依赖和合同检查报告。允许根声明、Skill、合同、说明、`.mcp.json`，以及 `mods/`、`hooks/`、`skills/` 下受支持的源码资源；仍有文件数量、深度和字节上限。`.env`、凭据、日志、构建目录及范围外脚本不打包；被排除项出现在报告中，不读取它们的正文。资源入包不等于获得执行许可，实际运行仍须通过原工具和权限检查。

doctor 不加载 guest、不启动脚本。test 仅在新临时工作区写样例并调用真实宿主产物校验器，随后清理样例。全部通过仍不代表项目 Skill、审批、外部服务或业务内容已验收；安装后需实际运行目标。回退插件代码不能撤销产物或外部写入。
