---
name: pure-div-converter
description: >
  【纯原生 div HTML 专用转换规则】
  适用于两类 HTML：
  1. 纯原生 div：所有元素都是 <div>，无框架组件标签
  2. Figma 高保真导出：全部绝对定位 + left/top 坐标 + id 含设计工具编号
  包含两类规则：
  1. 纯 div 无语义元素转换规则：通过 className、内联样式推断元素语义
  2. 绝对定位坐标布局解析规则：通过坐标映射保持视觉结构
  由 html-parser 在识别为原生 div 或 Figma 导出后调用。
---

# 纯 div 无语义元素 HTML 转换规则

本文中提到的 `SKILL.md` 均指 code 根技能 `../../../../../SKILL.md`。

当用户提供的 HTML 所有元素都是 `<div>`，没有 `<span>`、`<button>`、`<input>` 等语义元素时，通过 className、内联样式、嵌套关系、文字内容综合判断元素类型，进行语义推断转换。

**常见问题：** 用户提供的 HTML 所有元素都是 `<div>`，包括文字、按钮、输入框，仅靠标签无法判断元素类型。

---

## 大文件优先流程

当 HTML 是 Figma/MasterGo 这类大体积绝对定位导出时，必须先运行：

```bash
# autodev-code 技能根目录执行
python -X utf8 references/frontend-html/with-absolute-html/scripts/analyze_absolute_html.py "<html-file>" --project-root "<project-root>" --out-dir .frontend/html-analysis --output-name <task-stem>

# references/frontend-html/with-absolute-html/ 目录执行
python -X utf8 scripts/analyze_absolute_html.py "<html-file>" --project-root "<project-root>" --out-dir .frontend/html-analysis --output-name <task-stem>
```

转换时优先读取 `.frontend/html-analysis/<task-stem>.md`，只在需要核对局部样式或节点关系时回查原始 HTML。不要把完整原始 HTML 一次性交给模型转换。

默认模式是 `hybrid-fidelity`：先以原始 HTML 和 `.frontend/html-analysis/<task-stem>.md` 作为视觉基准，严格保留整体坐标、尺寸、颜色、边框、层级和文本位置；之后按“替换槽位计划”把明确的公共组件、项目组件或 AntD/Element 标准控件放回原视觉槽位。未进入槽位计划的内容继续按高保真还原。

只有在以下场景才生成 `output/<task-stem>-fidelity.html`：

1. 用户明确要求输出视觉还原 HTML
2. 本地调试需要一个可独立打开的视觉基准页
3. 后续验证步骤明确要求该文件

组件替换优先级：遵循 `SKILL.md` §组件来源优先级（用户指令 > 项目公共组件 > 相似页面模式 > 已装 UI 库 > fidelity-only）。

允许自动修正高保真错位的场景：

- 输入框、选择器、单选/复选、按钮由零散 div 拼出来，交互语义明显。
- 必填 `*` 重复、丢失或位置明显不符合 Form 组件行为。
- 控件内部文字、箭头、边框、选中态轻微错位，但外层槽位和相邻标签关系清楚。
- HTML 视觉像 Tabs/Table/Modal，但导出结构破碎；可替换为对应 UI 库组件。
- card 风格、带边框卡片感的 tabs 组合，只要本质是切换内容面板，也按 Tabs 处理。

修正边界：

- 只能修正组件槽位内部，不能移动外部 section、左右栏、顶部栏、底部操作区。
- 替换后的组件外层 wrapper 必须贴合原 bbox 或所在 region bbox。
- 如果公共组件拥有整个区域，删除该区域的高保真 div，避免双份 UI 叠加。
- 如果公共组件只拥有单个字段/按钮，只替换该字段/按钮，周围背景和分割线保留。

分区转换顺序：

1. 视觉基准：用 manifest 的 `visualBoxes` 和 `texts` 还原源 HTML 坐标布局。
2. 替换槽位计划：逐区决定 user component / project component / UI-library / fidelity-only。
3. shell 区域：顶部栏、侧边栏、面包屑、用户信息，项目已有布局组件或用户明确指定时替换；否则保留基准布局。
4. 主内容结构：根据 manifest 的 `sections` 标注语义，但不得重排原坐标。
5. 字段控件：根据 manifest 的 `fields` 建立 Form.Item、required、placeholder、options，并放回原视觉槽位。
6. 复杂区域：如评分规则、规则列表、动态表单，先查项目是否已有类似组件；没有才用 UI 库/自实现，但必须贴合原区域边界。
7. 底部操作：按项目按钮/弹窗模式实现确定、取消、重置等，位置跟随原 HTML。

每个分区只传该分区的 manifest 片段和少量原始 HTML 节点给模型。弱模型不应承担坐标聚类、公共组件查找、整页转换三件事。

禁止在 `hybrid-fidelity` 下做以下过度发挥：

- 把原绝对定位页面改成新的 Card/Grid/Tabs 页面骨架
- 新增 manifest 或 HTML 中不存在的辅助区块，例如“字段覆盖”
- 合并、拆分、重命名原字段
- 把左侧/顶部 shell 当成普通表单内容重排
- 为了“更工程化”改变原稿主区域比例
- 因为用了公共组件就重排整页
- 把静态装饰、背景块、分割线强行替换成业务组件
- 在没有证据时把普通 section 改成 Tabs/Card/Grid

---

## 识别特征

| 特征 | 说明 |
|------|------|
| 所有元素都是 `<div>` | 包括文字、按钮、输入框 |
| 文字内容直接写在 `<div>` 中 | 没有 `<span>` 或 `<p>` 包裹 |
| 按钮是 `<div class="btn">` | 不是 `<button>` |
| 输入框是 `<div class="input">` | 不是 `<input>` 或 `<el-input>` |

---

## 最高原则与基础识别

最高原则、允许 / 禁止范围、输出前自检见 `llm-prompt-template.md`「核心约束」和「输出前自检」。

基础识别（按 className + 内联样式 + 文字内容综合判断）：

| HTML | 转换为 | 关键信号 |
|------|--------|---------|
| `<div class="title">标题</div>` | `<div className={styles.title}>` | 文字内容直接用 div / p，不强转 span |
| `<div class="btn" style="background:#1890ff">提交</div>` | `<Button type="primary">` | className 含 btn / 主色背景 / 操作类文字 |
| `<div class="input" style="border:1px">请输入</div>` | `<Input placeholder="请输入" />` | className 含 input / 有 border |
| `<div class="select">请选择</div>` | `<Select placeholder="请选择" />` | className 含 select |
| `<div style="cursor:pointer">操作</div>` | `<Button onClick>` | cursor:pointer + padding + 操作词；不能只保留手型样式，必须落真实交互 |
| `<div class="text" style="font-size:14px">段</div>` | `<div className={styles.text}>` | 字号 / 行高样式提取到 Less |

核心原则：

1. 通过 className、内联样式、嵌套关系、文字内容综合判断元素类型
2. 不要看到 `<div>` 就当作 `div 容器`，要分析其实际用途
3. 按钮和输入框即使没有 `<button>` / `<input>` 标签也必须识别并转换

### 严格约束规则（必须遵守）

#### 1. 背景色必须归属到实际元素，禁止放到 ::after 伪元素

**常见错误：** LLM 把背景色放到 `::after` 伪元素，导致背景跑到标题下方。

**正确做法：**
```
HTML: <div class="card-header" style="background: #fff; padding: 16px;">标题</div>
正确: <div className={styles.cardHeader} style={{ background: '#fff', padding: '16px' }}>标题</div>

HTML: <div class="section" style="background: #f5f5f5;">
        <div class="title">标题</div>
      </div>
正确: <div className={styles.section}>
        <div className={styles.sectionTitle}>标题</div>
      </div>
Less: .section { background: #f5f5f5; }  ← 背景色在 section 上，不在 ::after
       .sectionTitle { /* 标题样式 */ }
```

**父子元素同时有背景色时的处理（高频错误）：**

```
HTML:
<div id="section" style="background: #F9F9FE; padding: 16px;">    ← 父容器有背景
  <div id="inner" style="background: #FFFFFF; padding: 10px;">   ← 子元素也有背景
    <div>内容</div>
  </div>
</div>

正确: 父子背景色都提取到 Less，分别对应各自的 class，不合并不丢弃
Less:
.section { background: #F9F9FE; padding: 16px; }
.inner { background: #FFFFFF; padding: 10px; }

禁止: 只取子元素背景色，丢弃父容器背景（导致背景层叠错误）
禁止: 把父容器背景色写到子元素上（颜色错位）
```

**禁止的操作：**
- ❌ 用 `::after` 伪元素承载背景色
- ❌ 把背景色从实际元素转移到伪元素
- ❌ 省略容器的背景色（父容器背景色与子元素背景色都必须保留）
- ❌ 父子背景色合并到同一个 class（层叠关系不同，必须分开）

#### 2. 必填标志 * 只转换一次，禁止重复显示

**常见错误：** HTML 中的 `*` 是必填视觉标志，转换后在 label 上加了 required，同时文案中又保留了 `*`，导致显示两个 `*`。

**正确做法：**
```
HTML: <div class="label">课程名称<span style="color: red;">*</span></div>
正确: <Form.Item name="courseName" required><span>课程名称</span></Form.Item>
                ↓
        如果 AntD Form.Item 的 required=true，则 label 中不需要显示 *
        如果必须显示 *，则 label 文本中不包含 *，由 required 装饰器处理

PRD 中的字段名称如果是 "课程名称*" → 只取 "课程名称"
然后 Form.Item required=true → AntD 会自动显示 *

禁止：label="课程名称*" + required=true → 会显示两个 *
```

**补充：Figma 导出中「*前缀」形式的必填标志识别**

Figma 导出的 HTML 中，必填标志通常不是独立的 `<span style="color:red">*</span>`，  
而是直接写在文本内容里，如 `*课程名称`、`*企业名称`。

```
识别规则：
当 div 的文本内容以 * 开头时 → 判定为必填字段

完整转换三步（缺一不可）：
  第1步：去掉开头的 * → 剩余文字作为 label 内容（"课程名称"）
  第2步：label 文字必须原样保留，不能省略
  第3步：加上 required={true}，让 AntD 自动显示红色 *

HTML: <div>*课程名称</div>
正确: <Form.Item label="课程名称" required rules={[{required: true}]}><Input /></Form.Item>
         ↑ label 有文字   ↑ required 有标记

错误示例（高频错误）：
禁止: <Form.Item required>          ← label 为空，标题消失
禁止: <Form.Item>                   ← label 和 required 都没有
禁止: <Form.Item label="*课程名称" required>  ← 两个 * 重复出现
禁止: <Form.Item label="课程名称">  ← 漏掉了 required
```

**⚠️ 高频错误提示：「label 消失」问题**

能力较弱的模型容易犯的错误：看到 `required={true}` 就认为任务完成，把 label 文字一起丢掉。

**验证方法**：转换完成后，必须检查每个 `Form.Item`：
- 有 `*前缀文本` 的字段 → `label` 属性必须存在且有文字内容
- 不允许出现 `label=""` 或缺少 `label` 属性的必填 `Form.Item`

```
自检清单（每个必填字段都要过一遍）：
[ ] label 文字是否保留？（去掉 * 后的剩余文字）
[ ] required 是否标注？
[ ] label 里有没有残留 * 符号？
```

**禁止的操作：**
- ❌ `label` 为空或缺失，只有 `required`（标题消失）
- ❌ `label="课程名称*" required=true`（显示两个 *）
- ❌ 文案保留 `*` 同时又用 required 属性
- ❌ 省略 required 属性让文案自己带 `*`
- ❌ 未识别 `*前缀文本` 形式，导致必填字段漏掉 required
- ❌ 文案保留 `*` 同时又用 required 属性
- ❌ 省略 required 属性让文案自己带 `*`

#### 3. 字段名称必须一比一还原 PRD，禁止过度发挥

**常见错误：** LLM 把 "职位" 变成 "关键人职位"，把 "姓名" 变成 "关键人姓名"，过度发挥。

**正确做法：**
```
PRD 中的字段名称：职位、姓名、年龄、性别、角色设定
转换后必须完全一致：<Input placeholder="职位" />、<Input placeholder="姓名" />

HTML 中如果显示的是缩写或简称：
  HTML: <div class="job-title">职位</div>
  正确: <Input placeholder="职位" />
  禁止: <Input placeholder="关键人职位" />  ← 不能自行添加"关键人"
```

**禁止的操作：**
- ❌ 自行添加限定词（"关键人职位" 而非 "职位"）
- ❌ 自行缩写或扩展字段名
- ❌ 根据自己的理解改写字段含义

#### 4. Tab 内容区左右栏边界必须严格遵守坐标

**常见错误：** 评分规则本应在右栏（left >= 分割点），但被放到了左栏或合并到其他卡片内。

**正确做法：**
```
坐标映射：
  - Tab 内容区容器: left=451, top=789
  - 分割点 ≈ 1131px
  - left < 1131px → 左栏（基础信息、人员情况、关键人信息）
  - left >= 1131px → 右栏（评分规则）

Tab 内容区结构必须是：
<Tabs>
  <TabPane>
    <Row>
      <Col span={12}>左栏内容</Col>
      <Col span={12}>右栏内容</Col>  ← 评分规则在这里
    </Row>
  </TabPane>
</Tabs>

禁止：
- ❌ 把右栏内容放到左栏的 Card 内部
- ❌ 忽略 left 坐标，只看 DOM 嵌套
- ❌ 把评分规则合并到"企业信息卡片"中
```

**验证方法：**
```
转换完成后检查：
1. TabPane 内部是否有 <Row><Col span={12}>×2</Col></Row> 结构
2. 左栏 Col 内是否只有 left < 分割点的元素
3. 右栏 Col 内是否只有 left >= 分割点的元素
4. 评分规则必须在右栏 Col 内，不在左栏 Card 内部
```

---

## 绝对定位坐标布局解析规则

**常见问题：** HTML 使用绝对定位（position: absolute），DOM 结构不等于视觉结构，解析时容易把元素放到错误的位置。

**核心问题：**
- 所有元素用 `left/top` 坐标定位，DOM 嵌套 ≠ 视觉嵌套
- 坐标连续的元素可能属于不同区域（如 Tab Bar 下方是 Tab 内容区）
- 左右栏边界需要计算 left 坐标的分割点

**解析步骤（必须按顺序执行）：**

### 第 1 步：建立坐标映射表

收集所有元素的定位信息，按 top 排序建立垂直层级：

```
| 元素 | left | top | width | height | 视觉区域 |
|------|------|------|-------|--------|---------|
| 头部容器 | 0 | 0 | 1920 | 64 | Header |
| 左侧卡片 | 21 | 138 | 400 | 1006 | 左侧内容区 |
| 右侧卡片 | 421 | 138 | 1479 | 1006 | 右侧内容区 |
| Tab Bar | 451 | 199 | 1420 | 40 | 企业客户选择栏 |
| Tab 内容区容器 | 451 | 789 | 640 | 516 | Tab 内容区 |
| 左侧区域元素 | 0(相对) | ... | ... | ... | Tab 内容区左栏 |
| 右侧区域元素 | 1131 | ... | ... | ... | Tab 内容区右栏 |
```

**【规则A：坐标类型区分——必须优先执行】**

Figma 导出的 HTML 中，`position: absolute` 元素的 `left/top` 是相对于**最近定位祖先**的偏移，不是相对于画布的绝对坐标。

```
识别方法：
1. 找到根容器（通常是 top=0 left=0 width≈画布宽度的最外层 div）
2. 根容器的直接子元素 → 其 left/top 是画布级绝对坐标（可直接用于分割）
3. 子容器内部的元素 → 其 left/top 是相对于该子容器的偏移（不可直接与画布级坐标比较）

判断方式：
- 某元素 left=1131，要确认这是画布坐标还是父容器内偏移
- 先找该元素的父容器，读父容器的 left 值
- 若父容器 left=421 w=1479，则该元素画布坐标 = 421 + 1131 = 1552（错误做法：直接用 1131 当画布坐标）
- 若父容器 left=0（根容器直接子级），则该元素画布坐标 = 1131（正确）

常见陷阱：
- ❌ 子容器内的 left=1131 被误认为画布级右侧大列
- ❌ 文字元素 left=0 top=0 被误认为在画布左上角（实为相对于父容器偏移）
- ✅ 只将根容器直接子级的坐标用于顶层分割点计算
```

**坐标映射表必须分层记录：**

```
【第0层 - 画布根容器】
  id=xxx  left=0 top=0 w=1920 h=1388  → 画布

【第1层 - 画布直接子元素（坐标即画布坐标）】
  Header   left=0   top=0   w=1920 h=64
  主白卡   left=20  top=84  w=1880 h=1328

【第2层 - 主白卡的直接子元素（坐标相对于主白卡）】
  左面板   left=21  top=138  w=400  h=1006  → 画布坐标: (20+21, 84+138)=(41,222)
  右面板   left=421 top=138  w=1479 h=1194  → 画布坐标: (20+421, 84+138)=(441,222)

【第3层 - 右面板的直接子元素（坐标相对于右面板）】
  Tab Bar  left=451 top=199  w=1420 h=40   → 注意！这里 left=451 是相对右面板的偏移
  ...
```

> **关键规则**：顶层左右分割点 = 第2层元素中，第2个大块容器的 left 值（相对于共同父容器的偏移）。
> Tab 内容区内部分割点 = 第3层（或更深层）元素的分组 left 值，归属于其父容器，不能提升为顶层分割点。

---

### ⛔ 第 1 步强制检查点

**在继续执行第 2 步之前，必须先输出以下格式的坐标映射表。未输出则视为第 1 步未完成，禁止进入第 2 步。**

```
【坐标映射表 - 第1步输出】✅

第0层 - 画布根容器：
  left=__ top=__ w=__ h=__

第1层 - 画布直接子元素：
  [元素名]  left=__ top=__ w=__ h=__
  ...

第2层 - 主白卡直接子元素（顶层分割候选）：
  [左面板]  left=__ top=__ w=__ h=__  右边界=__
  [右面板]  left=__ top=__ w=__ h=__  右边界=__
  顶层分割点 = 右面板.left = __px

第3层 - 右面板直接子元素（内部分割候选）：
  [Tab Bar]  left=__ top=__ w=__ h=__
  ...按left分组的元素群A: left≈__（左列）
  ...按left分组的元素群B: left≈__（右列，内部分割点=__px）

⚠️ 规则B验证：内部分割点__px 是否在右面板范围（__px ~ __px）内？
  → [是/否]，结论：[内部分割点归属Tab内部 / 重新检查]
```

> **自检问题（输出坐标表后必须回答）：**
> 1. 我是否区分了第2层坐标（顶层分割）和第3层坐标（内部分割）？
> 2. 是否有 left 值较大的元素群需要做规则B归属验证？
> 3. Tab Bar 宽度是否需要做规则C判断？
>
> 三个问题全部回答后，才进入第 2 步。

---

### 第 2 步：计算区域边界

**【重要】区域边界必须从当前 HTML 的实际坐标动态计算，不能套用示例中的固定数值。**

**垂直边界计算算法：**
```
1. 找最顶层容器（top=0, width≈全屏）→ 确定画布总高度
2. 找高度约 40-80px、位于 top=0 附近、width≈全屏的元素 → Header 区域
   Header 下边界 = Header.top + Header.height
3. 找位于 Header 下方、有背景色的大块容器 → 主内容区
4. 若存在 Tab Bar（高度约 40px，内含多个等宽子元素）：
   Tab Bar 下边界 = Tab Bar.top + Tab Bar.height → Tab 内容区起始 top
5. 页面底部固定栏：top ≈ (画布总高度 - 56px)
```

**水平分割点计算算法（针对左右双栏布局）：**
```
1. 在同一 top 层级，找两个并排的大块容器（宽度之和 ≈ 总宽度）
2. 左栏右边界 = 左栏.left + 左栏.width
3. 右栏左边界 = 右栏.left
4. 水平分割点 = 右栏.left（即 left >= 右栏.left 的元素属于右栏）

Tab 内容区内部分割点：
  在 Tab 内容区的直接子元素中，找 left 值最大的那组元素的最小 left 值
  → 该值即为内部分割点
  → left < 分割点 → 左栏；left >= 分割点 → 右栏
```

**【规则B：分割点归属判断——禁止把子容器内部分割点当顶层分割点】**

```
判断步骤：
1. 发现某个 left 值较大的元素群（如 left=1131 的一组元素）
2. 先找这些元素的父容器，读父容器的 left 和 width
3. 检查：这些元素的 left 是否在父容器范围内（父容器.left < 元素.left < 父容器.left + 父容器.width）
4. 若在范围内 → 该 left 是父容器内的内部分割点，不是顶层分割点
5. 若父容器就是根容器 → 才是真正的顶层分割点

示例（创建课程页面）：
  right-panel.left=421, right-panel.width=1479, right-panel.right=1900
  元素群 left=1131 → 1131 在 421~1900 之间 → 是 right-panel 内部分割点
  ✅ 正确：right-panel 内部分为左列(451~1091)和右列(1131~1871)
  ❌ 错误：把 left=1131 当顶层分割点，把评分规则切成独立的右侧大面板
```

**【规则C：Tab Bar 宽度决定 Tab 覆盖范围】**

```
判断规则：
  Tab Bar.width ≈ 父容器.width → Tab 内容区与父容器等宽（Tab 横跨整个父容器）
  Tab Bar.width < 父容器.width × 0.6 → Tab 只覆盖父容器的部分区域

当 Tab Bar 横跨整个父容器时（如 Tab Bar w=1420 ≈ 右面板 w=1479）：
  - Tab 内容区内部的左右分列是 Tab 的两个并排部分，不是"Tab内容区的左列"和"Tab外部的右面板"
  - 正确结构：Tab.TabPane → Row → Col(左列:企业信息) + Col(右列:评分规则)
  - 错误结构：Tab.TabPane(企业信息) 并排 独立右面板(评分规则)

Tab 内容区内部分割点计算：
  1. 找父容器（右面板）内，top > Tab Bar 下边界的所有元素
  2. 将这些元素按 left 值分组：找出明显的 left 跳变点
  3. 跳变点左侧的元素 → 左列；跳变点右侧的元素 → 右列
  4. 跳变点 = min(右列元素的 left 值)
```

**输出格式（必须输出，供后续步骤使用）：**
```
【区域边界计算结果】
画布总高度：<从HTML提取>px
Header 区域：top 0 ~ <Header.top+height>px
主内容区：top <X>px ~ <Y>px，left <A>px，width <W>px
左侧面板：left <A>px，width <B>px（相对主内容区）
右侧面板：left <C>px，width <D>px（相对主内容区）
顶层水平分割点：<C>px（右侧面板 left 值，相对主内容区）
Tab Bar：top <E>px，width <F>px，覆盖范围=<全右面板/局部>（若存在）
Tab 内容区：top <G>px（Tab Bar 下边界）（若存在）
Tab内部左列：left <H>px ~ <I>px（若存在）
Tab内部右列：left <J>px ~ <K>px（若存在，即内部分割点 = <J>px）
Footer：top <Z>px（若存在）

⚠️ 验证：内部分割点 <J> 是否在右侧面板范围内（<C> < <J> < <C>+<D>）？
  是 → 内部分割点，归属 Tab 内部两列
  否 → 重新检查父容器归属
```

---

### ⛔ 第 2 步强制检查点

**在继续执行第 3 步之前，必须先输出以下格式的边界计算结果。未输出则视为第 2 步未完成，禁止进入第 3 步。**

```
【区域边界计算结果 - 第2步输出】✅

画布总高度：__px
Header：top 0 ~ __px
主内容区：top __px，left __px，w __px
左侧面板：left __px，w __px（相对主内容区）
右侧面板：left __px，w __px（相对主内容区）
顶层分割点：__px

Tab Bar（若有）：top __px，w __px
  规则C：__px / __px = __%  → [横跨全右面板 / 局部覆盖]
Tab内容区（若有）：top __px
Tab内部左列：left __px ~ __px
Tab内部右列：left __px ~ __px（内部分割点 = __px）
Footer（若有）：top __px
```

> **自检问题（输出边界结果后必须回答）：**
> 1. 顶层分割点是从第2层坐标读取的，不是从第3层？
> 2. 如存在 Tab，规则C判断（Tab Bar宽/父容器宽）已完成？
> 3. 内部分割点已经过规则B验证，确认归属 Tab 内部而非顶层？
>
> 三个问题全部回答后，才进入第 3 步。

---

### 第 3 步：建立视觉层级树

```
主内容区
├── 左侧卡片（基本信息）
│   └── 课程名称、课程简介
└── 右侧卡片（企业信息）
    ├── 企业信息标题
    ├── 企业客户 Tab Bar
    └── Tab 内容区（top > 239px）
        ├── 左栏（left < 1131px）
        │   ├── 企业信息卡片
        │   │   ├── 基础信息
        │   │   └── 人员情况
        │   └── 关键人信息
        │       ├── 职位
        │       ├── 姓名、年龄、性别
        │       ├── 角色设定
        │       ├── 关键人介绍
        │       └── 企业痛点
        └── 右栏（left >= 1131px）
            └── 评分规则
```

---

### ⛔ 第 3 步强制检查点

**在继续执行第 4 步之前，必须先输出当前 HTML 对应的视觉层级树。未输出则视为第 3 步未完成，禁止进入第 4 步。**

```
【视觉层级树 - 第3步输出】✅

主内容区
├── [左面板名称]（基于第2步坐标）
│   └── [包含的区域/字段]
└── [右面板名称]
     ├── [标题栏]
     ├── [Tab Bar]（若有）
     └── Tab 内容区
          ├── 左列（left < __px）
          │   └── [包含内容]
          └── 右列（left >= __px）
              └── [包含内容]
```

> **自检问题（输出层级树后必须回答）：**
> 1. 层级树是否完全基于第1步坐标映射表和第2步边界结果推导，而非凭印象？
> 2. 有没有把 Tab 内部列错误地放到 Tab 外部？
> 3. 每个叶节点的归属，是否能从第2步输出的坐标范围里找到依据？
>
> 三个问题全部回答后，才进入第 4 步。

---

### 第 4 步：转换时保持坐标关系

**必须保留的坐标关系：**
- Tab Bar 的 top + height = Tab 内容区的 top（相邻关系）
- Tab 内容区左栏元素的 left 必须在分割点左侧
- Tab 内容区右栏元素的 left 必须在分割点右侧
- Tab 内容区容器包含左栏，但不包含右栏（右栏在容器外部）

**禁止的操作：**
- ❌ 把 Tab 内容区外的内容放入 Tab 内容区内部
- ❌ 改变元素的左右栏归属
- ❌ 忽略坐标连续覆盖关系（如 Tab Bar 和 Tab 内容区可能 DOM 平级，但视觉上是父子关系）

---

### ⛔ 第 4 步强制检查点

**在开始写代码之前，必须先输出组件结构映射表。未输出则禁止开始写代码。**

```
【组件结构映射 - 第4步输出】✅

视觉区域                → 框架组件               → Less class
────────────────────────────────────────────────────
[顶层容器]             → <div>                   → .pageWrapper
[左面板]               → <div>                   → .leftPanel（w=__px）
[右面板]               → <div>                   → .rightPanel
[标题栏]               → <div>                   → .blockTitle
[Tab Bar]              → <Tabs>                  → —
[Tab 左列]             → <Col flex="__px">       → .tabLeftCol
[Tab 右列]             → <Col flex="1">          → .tabRightCol
[评分规则卡片]         → <div>                   → .scoreDim
...（按实际 HTML 填写）
```

> **自检问题（输出映射表后必须回答）：**
> 1. 评分规则是在 TabPane 内部的 Col 里，还是 Tabs 外部的独立 div？
> 2. 左面板和右面板是同级的 flex 子元素，不是嵌套关系？
> 3. Less class 命名是否与第3步视觉层级树的节点名称对应？
>
> 三个问题全部回答后，才开始写代码。

---

### 第 5 步：验证视觉一致性

转换完成后，**必须对比坐标数据**：

```bash
# 检查 Tab 内容区容器和内部元素的 top 关系
# 容器 top=789, 内部元素 top 应 > 789
# 如果内部元素 top < 789，说明解析有误

# 检查左右栏分割点
# 左栏元素 left < 1131
# 右栏元素 left >= 1131
# 如果右栏元素 left < 1131，说明解析有误
```

**示例：错误的解析 vs 正确的解析**

```
错误解析：
<Tabs>
  <TabPane tab="企业信息">
    <Row>
      <Col span={12}>
        {/* 企业信息卡片 */}
        <Card>基础信息、人员情况</Card>
        {/* 关键人信息 */}
        <Card>职位、姓名...</Card>
      </Col>
      <Col span={12}>
        {/* 评分规则 */}
      </Col>
    </Row>
  </TabPane>
</Tabs>

正确解析：
<Tabs>
  <TabPane tab="企业信息">
    <Row>
      <Col span={12}>
        {/* 企业信息卡片（属于左栏） */}
        <Card>基础信息、人员情况</Card>
        {/* 关键人信息（属于左栏） */}
        <Card>职位、姓名...</Card>
      </Col>
      <Col span={12}>
        {/* 评分规则（属于右栏） */}
      </Col>
    </Row>
  </TabPane>
</Tabs>

关键区别：
- 企业信息卡片和关键人信息都在左栏（left < 分割点）
- 评分规则在右栏（left >= 分割点）
- 不要把评分规则放进"企业信息卡片"内部，它们是并列关系
```

---

## 调用位置

本规则由 `html-parser` 在执行 LLM 转换时调用，详细调用流程见 [html-parser.md](../html-parser.md)。

**调用时机：** 当 HTML 识别为原生 div HTML（不含框架组件标签）时，在 LLM Prompt 中包含本规则的转换要求。

**调用方式：** 在 LLM Prompt 模板中插入本规则的完整内容，确保 LLM 转换时遵循上述识别特征和转换规则。
