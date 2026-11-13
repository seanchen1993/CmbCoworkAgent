---
name: code-frontend-with-absolute-html
description: /autodev-code 内部绝对定位高保真 HTML 路线。它负责定义绝对定位 / 碎片 div / Figma 导出类 HTML 的适用条件、主流程 write_todos 与失败兜底方式。
---

# 绝对定位高保真 HTML 路线

这是 `/autodev-code` 内部的绝对定位高保真 HTML 实现路线目录。

- 当前路线入口：`SKILL.md`
- 当前路线参考：`references/`
- 当前路线脚本：`scripts/`

本文中提到的 `SKILL.md` 均指 code 根技能 `../../../SKILL.md`。若本文和 code 根技能冲突，以 code 根技能的 Source/Method Bundle 优先级、HTML 分支总控契约和 code_done 收尾规则为准。
命令示例兼容两种工作目录：
- 如果当前目录是 `autodev-code` 技能根目录，使用 `references/frontend-html/with-absolute-html/scripts/...`
- 如果当前目录已经是 `references/frontend-html/with-absolute-html/`，使用 `scripts/...`

## 1. 这条路线什么时候使用

当满足任一条件时，使用本路线：

| 输入 | 处理 |
| --- | --- |
| 用户上传的 HTML 页面主体、关键分区或多个视觉块主要由绝对定位 / 碎片 div 驱动 | 走本路线 |
| 用户直接粘贴的 HTML 明显是设计导出稿 / 坐标稿 | 走本路线 |
| 用户提供的设计产物已经能导出或拿到实际 HTML，且结构明显偏导出稿 | 走本路线 |

绝对定位强制信号（命中任一条，且该信号已覆盖页面主体、关键分区或多个视觉块时，就**禁止**转去标准 HTML 路线）：

- 用户明确说“高保真”“设计稿导出”“Figma/MasterGo 导出”“绝对定位”
- 全局或局部大量 `position:absolute`
- utility class / Tailwind 中大量 `left-[...]`、`top-[...]`、`w-[...]`、`h-[...]`
- 存在大量 `clip-path`、`data:image/svg+xml`、渐变、阴影、像素级尺寸
- 页面主体、关键分区或多个视觉块是视觉拼装容器，而不是原生语义表单 / 表格 / DOM 流布局

即使分析脚本把这类输入判成普通 `html`，也不能改走 `../with-standard-html/SKILL.md`；只能继续走本路线，并把分析结果视为“低置信度辅助信息”。

如果用户提供的是高保真 HTML，但绝对定位只出现在局部、稀疏、装饰性区域，页面主体仍由标准 DOM / flex / grid 驱动，则不使用本路线，应转去 `../with-standard-html/SKILL.md`。

当满足以下条件时，不走本路线：

| 输入 | 处理 |
| --- | --- |
| 只有截图 / 图片，没有 HTML | 返回 `/autodev-code` 主流程；若任务明确要求 HTML 还原则停止并要求补充 HTML |
| 只有 Figma / 设计链接，但拿不到实际 HTML | 返回 `/autodev-code` 主流程；若任务明确要求 HTML 还原则停止并要求补充 HTML |
| 只有 HTML URL，但最终拿不到实际内容 | 停下并要求用户补 HTML 文件或内容 |

## 2. 这条路线只负责什么

本文件只负责：总原则、主流程 write_todos、交接边界与失败兜底。

它不展开实现细则，不替代 code 根技能 `../../../SKILL.md` 的全局优先级，也不重复 `references/html-parser.md` 的执行规则。
本路线的真实执行顺序见第 3 节；未完成第 3 节前，不得提前转交 `references/html-parser.md`。

## 3. 路线总原则

### 3.1 HTML 是视觉契约

只要用户已经提供这类高保真绝对定位 HTML：

- 表现层样式以高保真还原为准
- 不再强要求字体、字号、字色、背景色、边框、边框色、`border-radius` 等去对齐 token
- design system / token 只用于 HTML 没给出的交互态和默认组件细节

### 3.2 先整页恢复，再局部组件化

本路线统一使用两阶段心智：

| 阶段 | 目标 |
| --- | --- |
| Stage 1 | 先恢复整页视觉与结构 |
| Stage 2 | 再替换已经证明安全的组件槽位 |

### 3.3 有高保真时，不为“工程化”主动改视觉

不要为了更像 design system / AntD 默认样式 / 更整齐 / 更像某个已有页面，就改掉高保真里已经明确给出的视觉结果。

### 3.4 同一页面多个 HTML 先统一分区，再决定拆分

如果用户提供的是同一页面的多个 HTML 片段：

- 先判断这些片段是否属于同一业务页面的不同视觉分区
- 只要属于同一页面，就先统一成一个页面级实现方案，再按视觉分区与复用价值拆出同目录局部组件
- 默认保留“页面壳层 + 数据编排”在主页面文件，把筛选区、统计区、图表区、表格区、弹窗区等清晰分区拆到同目录局部组件

### 3.5 脚本任务块与地位

在 `with-absolute-html` 路线里，脚本执行是主流程 write_todos 的独立任务块，**默认必跑**，不要让模型自行决定跳过。

这样做的目的不是让脚本替代原始 HTML，而是把下面这些容易不断膨胀的识别逻辑尽量下沉到脚本：

- 内容盘点
- 页面分区与 archetype 判断
- field / table / chart / icon / interaction 检测
- 项目组件扫描
- UI 库检测
- replacement slots 候选生成

脚本地位：

- **必须执行**：用于统一识别入口，减少模型自由发挥。
- **不能越权**：脚本产物只是辅助材料，原始 HTML 仍然是视觉真相。
- **冲突时原始 HTML 赢**：只要脚本结论与原始 HTML 冲突，以原始 HTML 为准。

出现以下任一情况时，即使脚本已跑，也必须把它降级为“辅助信息”，不要把它当主依据：

- 脚本只识别出极少区域，但原稿明显有多个大块
- 图表、分页、时间线、上传区、Tab 内左右栏等明显区域没被识别出来
- 文本被异常合并，或区域命名明显失真
- 脚本给出的组件 / 图标 / 图表判断与你直接读原始 HTML 的结果冲突
- 你已经能从原始 HTML 直接稳定看出布局、内容和槽位关系，而脚本摘要反而在打断判断
- 对表格多、图表多、左右对比强、时间线/上传/分页并存、模块边界复杂的页面，默认把脚本视为“盘点材料”，不要把它视为结构裁判

## 4. 默认读取顺序

进入本 route 后，先把下面这组 write_todos 视为主流程骨架；**未完成前不得提前转交 `references/html-parser.md`**。脚本仍然默认必跑，任何异常都按 §7 降级处理，不阻塞后续步骤。

### 步骤 1: 读取 HTML 来源

- [ ] 读取 HTML 来源。

### 步骤 2: 读取项目文档

- [ ] 写出页面模块清单（write_todos）。
  - [ ] 读取项目 `AGENTS.md`
  - [ ] 读取项目 `architecture/`
  - [ ] 读取组件说明，优先 `architecture/components/`
  - [ ] 读取相似页面 / 相似模块
  - [ ] 读取真实源码证据，例如 import、实际使用方式、路由 / 菜单 / API helper / 样式文件
  - [ ] 将以上证据与原始 HTML / 脚本产物交叉核对，再继续后续实现
  - [ ] 这份清单是固定前置检查，不会因为原稿是高保真 HTML 就省略；只有当项目里确实不存在对应资料时，才把该项标记为”无可用证据”并继续下一项。
  - [ ] 页面模块清单只负责实现范围盘点，不承担脚本执行。

### 步骤 3: 执行脚本

- [ ] 写出脚本清单（write_todos）。
  - [ ] 建立独立的脚本清单，不并入页面模块清单
  - [ ] 确认 `--project-root`、`--task-stem`、`--html-file` 参数完整
  - [ ] 确认 HTML 来源可读，且多片段输入已按页面模块合并
  - [ ] 执行 `prepare_html_analysis.py`
  - [ ] 脚本清单必须和页面模块清单同时存在，最低粒度至少要覆盖 `参数确认 / 执行脚本 / 检查产物 / 失败降级` 四类事项，不能只用一句”脚本执行”代替。
  - [ ] 使用完整命令模板，参数齐全后再执行：
    - `autodev-code` 技能根目录：
      ```
      python -X utf8 references/frontend-html/with-absolute-html/scripts/prepare_html_analysis.py \
        --project-root . \
        --task-stem <task-stem> \
        --html-file <HTML_PATH>
      ```
    - `references/frontend-html/with-absolute-html/` 目录：
      ```
      python -X utf8 scripts/prepare_html_analysis.py \
        --project-root <CODE_WORKSPACE> \
        --task-stem <task-stem> \
        --html-file <HTML_PATH>
      ```
    - `<task-stem>` 由调用方自定义，建议格式 `task-1` / `task-<页面短名>`（如 `task-1-create-course`），仅用于命名产物；全套技能里所有出现 `<task-stem>` 的路径都指同一个值。
    - 同一页面多个 HTML 片段时，重复 `--html-file` 或用逗号分隔。
    - 对多片段输入，脚本会生成 merged analysis input 做聚合分析；但原始 HTML 仍然是视觉真相。
    - 只要原始 HTML 与脚本结论冲突，就优先相信原始 HTML。

### 步骤 4: 读取脚本产物

- [ ] 读取上下文。
  - [ ] 检查 `.frontend/html-analysis/<task-stem>.md`
  - [ ] 检查 `.frontend/html-analysis/<task-stem>.json`
  - [ ] 检查 `.frontend/html-analysis/<task-stem>-checklist.md`
  - [ ] 若脚本失败，保留失败原因并切回降级路径
  - [ ] 若脚本产物齐全：先读取 `<task-stem>-checklist.md`，再读取 `<task-stem>.md`（完整版 handoff），最后回到原始高保真 HTML 做主判断。
  - [ ] 若走降级路径：直接以原始高保真 HTML 为主。
  - [ ] 若 checklist / handoff 标记 `componentizationMode=conservative` 或 `analysisConfidence.level != high`：先锁定原始 HTML 的宏观布局、模块边界、表格/图表/时间线/上传等所有权，再把脚本产物仅用于缺项点查与 whole-section 保留，不要让 `replacementSlots` 主导大块组件化。

### 步骤 5: 处理 assets 资源

当高保真 HTML 压缩包中包含 `assets/` 文件夹时，必须执行 `../references/assets-processing-guide.md` 中定义的完整流程：

1. 检查并扫描 assets 目录
2. 对每个被 HTML 引用的 asset 执行四级优先级判定
3. 创建 assets 使用映射表
4. 复制必要的 assets 到项目目录
5. 输出 assets 处理总结

Assets 处理总结将作为后续”编码前简报”的输入材料。详细规则和实施步骤参见 `../references/assets-processing-guide.md`。

**重要：** 仅处理 HTML 中实际引用的资源文件，未被引用的文件无需处理。

### 步骤 6: 转交 parser

- [ ] 转交 `references/html-parser.md`。
  - [ ] `hasManifest=true`：表示脚本产物可用，但它们只是辅助。
  - [ ] `hasManifest=false`：表示脚本失败，后续完全以原始 HTML 为主。

### 步骤 7: 生成代码

- [ ] 完成主线代码生成、页面拆分 / 抽取与最低校验。
- [ ] 主线完成后先输出交付总结（若走降级路径，须在总结里显式声明”已跳过 Stage 1 脚本及原因”），并带回统一前端回检输入：目标源码路径、原始 HTML 路径、可用 `.frontend/html-analysis/*.json` 路径（没有或降级时写 none）、PLAN 路径、`uiLibraryTarget`、`antdMode`、`auditRequired`；再返回 `/autodev-code` 主流程，由 code 根技能执行项目级验证、统一前端回检和 `code_done` 推进；不得发起独立回检选择。

## 5. 转交规则

完成第 4 节的 write_todos 和上下文检查后，默认直接转交 `references/html-parser.md`。

- 默认入口：从 `§3 分类 HTML` 开始
- 转交时附带状态：`hasManifest=true`（脚本产物齐全，仅作辅助）或 `hasManifest=false`（已走 §7 降级）
- `hasManifest=false` 时 `references/html-parser.md` 直接以原始 HTML 为唯一视觉源继续，不要再要求脚本

## 6. 增量修改

如果项目里已经存在目标页面：

1. 先读取当前页面文件
2. 以高保真 HTML 对比差异
3. 只改变化部分
4. 保留原文件中无关的逻辑、导入和状态管理

## 7. 失败兜底（降级路径）

核心原则：**脚本异常永远不阻塞主流程**。任何脚本失败都按下面的统一降级处理。

- URL 拿不到真实 HTML 时，停下并要求用户补 HTML，或返回 `/autodev-code` 主流程判断是否可按 specs/design/PLAN 直接实现（这是输入缺失，不是脚本失败）
- `prepare_html_analysis.py` 出现以下任一情况都按"降级路径"继续：
  - Python 运行时缺失 / 被禁用 / 版本不兼容
  - 脚本依赖（标准库以外）安装失败
  - 脚本本身语法错误、文件被截断、import 失败
  - 缺少必填参数（`--project-root` / `--task-stem` / `--html-file`）导致 argparse 报错
  - 路径写错、HTML 源不存在
  - 文件 IO 错误（磁盘满 / 权限不足）
  - 子进程崩溃、超时、产物写入残缺
  - 任何未在上面列举的异常
- 降级路径动作：
  1. 不再重试脚本，也不要原地等待用户补救
  2. 直接进入 §4 第 4 步，转交 `references/html-parser.md`，并带 `hasManifest=false` 状态
  3. 由 `references/html-parser.md` 以原始 HTML 为唯一视觉源继续整页恢复与组件化
  4. 在最终交付总结里显式列出"已跳过 Stage 1 脚本"和具体原因（如"argparse 缺参数"、"语法错误 line N"、"FileNotFoundError"）
- 唯一例外（不走降级、必须先修复）：模型自己虚构了"已跳过原因"而实际并未执行脚本。脚本必须至少被真实尝试执行一次，并捕获真实异常信息

## 8. 和其它文件的边界

| 文件 | 一句话职责 |
| --- | --- |
| `../../../SKILL.md` | `/autodev-code` 总入口 + 全局优先级与执行清单 |
| `SKILL.md` | 绝对定位高保真 HTML 路线入口、读取顺序与转交规则 |
| `references/html-parser.md` | 真正把路走完（分类、整页恢复、组件替换、写代码） |
| `/autodev-code` 主流程 | HTML 上下文完成后执行项目级验证、统一前端回检与 `code_done` 推进 |
