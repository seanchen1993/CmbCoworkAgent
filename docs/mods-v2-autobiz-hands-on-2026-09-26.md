# 用 Autobiz 实际体验 DIY Claw

本教程观察的是“任务如何被验收、失败后怎么处理、谁能推进阶段”。用同一份订单导出代码和同一条消息，对比关闭规则、仅报告、自动修复与阶段推进。不是比较模型回答的措辞。

## 已为本机准备的材料

| 材料 | 路径及用途 |
| --- | --- |
| 最新开发应用 | `C:\ai\CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2` |
| 新生成的 Autobiz Mods ZIP | `C:\ai\CmbCoworkAgent-mods-v2\output\autobiz-diy-20260926\AutobizDevOps_Plugin_Kanban_Mods.zip` |
| **要在会话中选择的练习项目** | **`C:\ai\autobiz-mods-lab-20260926`** |
| 工作流工具源码 | `C:\ai\autobiz_kanban`；宿主从固定 Git 提交读取 compiler/validator，不是本次要改代码的业务项目 |
| 项目外的独立验收工具 | `C:\ai\CmbCoworkAgent-mods-v2\output\autobiz-diy-20260926\verify-project.cjs` |

旧 `output/autobiz-mods-final` 包生成于 9 月 21 日，本次应使用上表新包。ZIP 已通过 CLI 包结构及注册检查；本机 Git、Python 3、固定提交 `8db1ec937d6ed3d271cb9dc540310d6633c91e70` 可用，C 盘为本地固定 NTFS。

练习项目已经准备好，不用 `npm install`。任务是实现 `order-export.cjs` 的订单 CSV 导出：精确状态过滤、数字排序、CSV 特殊字符转义、Unicode、空结果及输入不变。初始代码故意不满足要求，有 7 条业务断言，需求评审报告也尚未生成。

## 1. 启动应用、选择项目

```powershell
cd C:\ai\CmbCoworkAgent-mods-v2
npm run dev
```

新建普通本地会话，关联 **`C:\ai\autobiz-mods-lab-20260926`**。主助手选择可用模型；Autobiz 的自动代码评审调用应用默认模型，因此也要确认应用默认模型可用。仅更改会话模型不一定更改插件评审模型。

不要把 `C:\ai\autobiz_kanban` 或 ZIP 解压目录选为这次业务工作区；我们用 Autobiz 管理订单导出项目，不是在修改 Autobiz 自身。

## 2. 安装并授权 Autobiz Mods

1. 在这个项目会话进入「自定义 → Function Mods」。
2. 当前开发版管理口令是 `admin123456`，点击「解锁设置」。
3. 点击「上传 Mods（ZIP）」，选择上表的新 ZIP。已有同名同作者插件会更新；旧摘要授权不能代替新版本授权。
4. 勾选「启用 Mods 功能（应用级）」及「启用项目 Mods」。确认界面上的「作用目录」是练习项目。
5. 找到 `AutobizDevOps_Plugin_Kanban_Mods`，核对版本摘要后点「授权以上能力」，确认状态变为「已授权」。本次不需要给练习项目授权其他 Mods。

不要通过「安装示范 Mods」替代上传，这个按钮安装的是其他内置例子。也不需要手工启用 `classic-hooks.json`；它是保留的旧配置，重复启用会干扰本次对照。

## 3. 先看看板基线

回到对话，逐条输入：

```text
/kanban
/kanban-check order-export
```

应能找到 `order-export`，checkpoint 为 **`requirements_eval_in_progress`**，缺少 `REQUIREMENTS_EVAL.md`。`/kanban-check` 只检查当前阶段产物是否存在且非空，不运行模型、测试或完整 validator，也不会推进状态。

在外部 PowerShell 验证代码基线：

```powershell
cd C:\ai\autobiz-mods-lab-20260926
npm test
```

此时应失败，首个断言为 `filter and numeric ordering`。这说明示例中确实有业务缺陷，不是因为没有安装测试工具。

## 4. 用同一条消息做三轮对照

每轮都使用下面这段话。它刻意让模型先申请完成；遇到宿主要求才修复，方便分清“模型自发检查”和“应用规则强制检查”。

```text
这是 order-export 的完成规则对照测试。现在先只回复“申请完成”，不要主动读取、修改文件，也不要主动运行测试。
只有随后收到宿主的 Completion gate requested revision 或完成检查要求修复的反馈时，才：
1. 按 requirements.md 修复 order-export.cjs；
2. 运行 npm test；
3. 将逐条需求、代码实现和真实测试结果写入 .autobizdevops/features/order-export/REQUIREMENTS_EVAL.md，只有满足要求时才写 verdict: PASS；
4. 再次申请完成。
不得修改需求、business.spec.cjs、package.json 或权限配置，不得直接修改 .autobizdevops/state.json、STATE.md。阶段推进交给宿主完成规则。
```

### A：关闭自动验收

进入「自定义 → Function Mods → AutobizDevOps_Plugin_Kanban_Mods → 完成检查规则」，选择「完成模式：关闭」并点「保存项目规则」，然后发送上面的消息。

预期：主助手可以直接结束，本插件不发起本轮完成检查；代码仍错误，checkpoint 不变。看板能用不等于自动验收已经启用。

### B：只检查和报告

仍在同一条目的「完成检查规则」中填写：

| 配置 | 值 |
| --- | --- |
| 完成模式 | 仅报告 |
| 检查范围 | 整个项目 |
| Feature ID | `order-export` |
| 执行检查 | 代码评审、单元测试、Autobiz 业务验收 |
| E2E | 不勾选；本例没有 E2E 脚本 |
| 高级预算：最大修复次数 | 2 |
| 高级预算：最长时间（秒） | 600 |
| 高级预算：模型总预算（tokens） | 350000 |

点击「检查 Autobiz 环境」，确认基础依赖就绪，再点「保存项目规则」。仅报告不会配置自动推进；未检查/检查失败时不能保存启用的 Autobiz 检查。

发送相同消息。预期：任务底部「完成检查证据」出现实际测试失败、缺少评审报告等记录，但这条规则允许结束，不要求自动修复，checkpoint 不变。代码评审调用模型，意见可能不同；真实测试失败应当保留，不能因为“允许结束”就称验收通过。

### C：修复、复检，成功后推进当前阶段

保留 B 的范围、Feature 和检查项，改为：

| 配置 | 值 |
| --- | --- |
| 完成模式 | 自动修复并复检 |
| 自动推进阶段起点 | `requirements_eval_in_progress` |

再次点击「保存项目规则」，发送**同一条消息**。遇到测试运行、文件修改或阶段提交审批时，核对目标在练习项目内，再决定是否批准。自动修复仍受原权限和预算约束。

应该观察到以下过程：

1. Agent 申请完成，宿主发起已选检查。
2. 检查发现问题，宿主向**原 Agent**提出修复要求。
3. Agent 修改实现、运行测试并补充真实需求评审报告。
4. 完成前重新采集证据，重新执行所选检查。
5. 全部要求满足且阶段写入获准后，由宿主把 checkpoint 推进到 **`requirements_eval_done`**。

首段显示“申请完成”不是流程结束；等生成/工具执行结束，再看最新「完成检查证据」。在 `/kanban` 点「刷新真实状态」，看 checkpoint 是否实际改变。`/kanban-last` 只看最近插件评审意见，不能代替宿主完整证据。

只会推进已选择的这个阶段，不会自动一路运行到发布。模型可能修复失败，权限拒绝、预算不足、评审 JSON 无效或依赖问题都会使流程停止并给原因；这时不能强行写成验收成功。如果 A/B 轮模型自行修改了代码，这次对照条件已改变，应新建练习项目重新演示。

## 5. 用项目外工具核验，避免只看模型自述

完成 C 后运行：

```powershell
node C:\ai\CmbCoworkAgent-mods-v2\output\autobiz-diy-20260926\verify-project.cjs
```

工具使用放在业务项目外的原始 7 条断言，并核对原需求、测试、package.json 和 Feature spec 的哈希。成功演示应同时满足：

```text
independentBusinessPassed: true
protectedFilesUnchanged: true
checkpoint: requirements_eval_done
BUSINESS_ASSERTIONS_PASSED:7
```

这只验证磁盘业务结果和状态，完整授权/检查/推进链还要看任务里的「完成检查证据」。若只有模型说通过、只有报告写 PASS，或 checkpoint 是手工改的，都不能算完整演示成功。

## 这就是本例的 DIY

| 你改的东西 | Claw 的行为变化 |
| --- | --- |
| 安装 Autobiz Mods | 增加 `/kanban` 看板、项目状态查询和自动代码评审处理器 |
| 设置检查组合 | 完成前执行你选的代码评审、项目测试与 Autobiz validator |
| 选择仅报告/自动修复 | 从“报告后结束”变为“失败后让原 Agent 修复并重查” |
| 指定 Feature 和阶段起点 | 验收通过后由宿主受控推进该 Feature 的当前阶段 |

这些变化通过外置模块与项目规则完成，本次没有修改 Agent/Electron 主工程代码。它们也不是凭空让模型更聪明，而是为 Claw 配置更明确、可检查的工作流程。不是 Claude Code 全量兼容证明。

建议汇报保存三组截图：A 的原始失败/原 checkpoint，B 的失败证据但允许结束，C 的修复复检与阶段提交记录，以及项目外验证工具的成功输出。

## 常见卡点与重复演示

- 只输入 `/kanban`：只打开看板，不会启用完成规则。
- 改 `/kanban-mode` 却提示回应用设置：这是正常的应用规则接管；已保存应用规则后应统一在「完成检查规则」修改，看板按只读摘要展示。
- 找不到命令/没有运行：检查是否用了新 ZIP、当前项目摘要已重新授权、两个开关都开启、当前会话项目路径正确。
- 评审调用失败：检查应用默认模型，而不只是会话选择的模型；保留错误，不手填 PASS 绕过。
- 只有单元测试通过、阶段没变：检查 Feature、Autobiz 勾选项、起点、评审报告、阶段审批，以及全部检查的最终结果。
- 关闭试验：将本插件的「完成模式」设为「关闭」并保存，或关闭这个项目的 Mods；不必影响其他项目。

要再演示一遍，使用新目录，不覆盖已经推进过的状态：

```powershell
cd C:\ai\CmbCoworkAgent-mods-v2
node --import tsx output/autobiz-diy-20260926/prepare-project.ts C:\ai\autobiz-mods-lab-second
```

然后在应用新建普通本地会话、选择这个新目录并重新配置项目授权。独立验证可将新目录作为 `verify-project.cjs` 的参数。

## 本次已验证与尚需你实测的部分

已验证新包可加载和注册；练习项目原生业务测试失败，固定 upstream compiler 能解析工作流，validator 因缺少报告而拒绝；在另一临时副本修正业务实现并写入真实测试报告后，7 条独立断言及同一 upstream validator 均通过。临时验证未提交 checkpoint，练习项目仍保持初始错误和原阶段。本次没有替你调用模型或修改应用里的安装/授权/规则。

本次是交互操作材料准备，尚未将这个新 ZIP 配合你的真实模型跑完整 A/B/C。旧真实模型订单演示及历史回归不能替代你这次的实际结果；以上成功条件供你在应用中验收。材料和验证回执位于 `output/autobiz-diy-20260926/`。
