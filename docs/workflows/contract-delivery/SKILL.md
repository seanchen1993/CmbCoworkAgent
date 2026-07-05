---
name: contract-delivery
description: 当用户要求"契约交付/端到端交付一个开发需求"、"自动开发并逐条验收"、"用契约驱动工作流实现需求"时使用。通过 ultra workflow(workflow 工具)运行契约驱动交付脚本:需求固化为逐条验收合同,多轮自主实现-验证-对抗复核,直到每条标准都有证据。不适用于纯问答、代码解释等非交付类任务。
---

# 契约驱动端到端交付(contract-delivery)

把开发需求交给契约驱动工作流自主完成:成契(每条验收标准带稳定 ID 与核查方式)→ 按轮次实现-逐条验证-对抗复核 → 终审命令核对 → 交付逐条对照的证据矩阵。simple/standard/complex 三档自适应,同一入口。

**安装(给使用者):** 将本技能整个目录拷贝到 `~/.cmbcoworkagent/skills/contract-delivery/`(用户级)或工作区技能目录即可启用;脚本捆绑在本技能的 `workflow/` 子目录中,随技能分发。

## 前置条件

- 本技能**必须通过 workflow 工具(ultra workflow 模式)执行脚本**,不要自己写内联脚本,也不要试图在普通对话流程里模拟它。
- 若当前会话没有 workflow 工具,直接告知用户"需要在支持 ultra workflow 的模式下使用",停止。

## 使用步骤

### 第 1 步:部署脚本到工作区

workflow 工具的 `scriptPath` 只能解析**工作区内**的路径。检查工作区是否已有脚本,没有或内容过期则从本技能目录复制(相对路径以本 SKILL.md 所在目录解析):

```bash
mkdir -p <工作区>/.cmbdevclaw/workflows
cp <本技能目录>/workflow/contract-delivery.workflow.js <工作区>/.cmbdevclaw/workflows/
```

已存在时先 `diff` 比对:内容不同则用技能内的版本覆盖(技能随版本分发,以技能内为准),并告知用户已更新。

### 第 2 步:确认需求文本

- 需求应当明确(做什么、约束、验证命令)。**需求文本是续跑锚点:同一需求必须逐字一致**,不要润色、翻译或增删标点。
- 需求含糊时不要猜:先向用户澄清,或直接运行——脚本的成契阶段会以 `openQuestions` 阻塞并出报告,把待确认项带回来。

### 第 3 步:调用 workflow 工具

```
scriptPath: ".cmbdevclaw/workflows/contract-delivery.workflow.js"
args: <需求文本原样>            // 最常用
```

带选项时 args 传对象(requirement 字段放需求原文):

| 选项                         | 作用                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`                   | 注入人机协商好的合同对象(title/problem/goal/complexity/criteria[]/globalValidationCommands 等);criteria 每条 `{id,text,verify,hint}`,verify ∈ command/code/test/e2e。形状不合法会直接报错 |
| `complexity`                 | `simple`\|`standard`\|`complex`,覆盖自动档位                                                                                                                                              |
| `forceAcIds`                 | 如 `["AC-3"]`,强制重新证实指定标准                                                                                                                                                        |
| `maxRounds` / `maxFixRounds` | 收敛轮次 / 每包修复轮次预算(整数)                                                                                                                                                         |
| `resume: false`              | 禁用续跑,从零开始                                                                                                                                                                         |
| `artifactDir` / `outputPath` | 自定义产物目录 / 交付报告路径                                                                                                                                                             |

### 第 4 步:解读结果并汇报

- 返回值与 `交付报告.md` 含**验收矩阵**(每条 AC:状态/轮次/证据)、终审命令核对、输出 token。向用户汇报时以矩阵为准,逐条说清哪些已证实、哪些未证实及原因。
- 产物目录(默认 `.cmbdevclaw/契约交付/<需求slug>/`):`状态.json` 是账本(续跑锚点),`交付合同.md`、`项目画像.md`、`rounds/round-N/` 是过程档案。
- 结论 `needs_fix`/`已阻塞` 时**如实转告**,不要粉饰;把"下一步"建议一并给出。

## 续跑语义(重要)

| 情况                                                                      | 做法                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 跑完是 needs_fix,要继续修                                                 | **同一需求文本原样再调一次**——账本续跑,只做未证实标准,已证实跳过                                      |
| 运行中途崩溃/被中止                                                       | 用 workflow 工具的 `resumeFromRunId` 恢复该 run(免费回放已完成调用)                                   |
| 想重打某条已证实的标准                                                    | args 传 `{ requirement: <原文>, forceAcIds: ["AC-x"] }`                                               |
| 注入的合同与上次**验收语义相同**(criteria/命令/约束一致,顺序与空白不敏感) | 自动按账本续跑;此时改 `complexity/title` 等元数据会生效但进度保留(simple→standard 会自动重探项目画像) |
| 注入的合同验收语义**变了**                                                | 账本按新合同重建,轮次/画像重置——这是有意行为                                                          |

> **验收语义只认 criteria/globalValidationCommands/constraints/conventions/nonGoals**(顺序与空白不敏感)。`goal/problem/title/complexity` 属于元数据:改了它们不会触发重新验证——如果目标变化意味着验收内容变化,必须同步修改 criteria,否则会带着旧账本直接可交付。

## 禁止事项

- 不要改写用户的需求文本再传入(锚点会断,续跑失效)。
- 不要绕过 workflow 工具手动模拟流程,也不要把脚本内容作为内联 script 传入(丢失落盘脚本的可续跑性)。
- 不要在结论为 needs_fix 时替脚本"补一把"直接改代码——正确姿势是续跑或 forceAcIds,让账本与证据保持一致。
- 成契被阻塞(openQuestions)时,把问题原样带给用户澄清后重跑,不要代替用户编造业务规则。
