# HTML 转换 Prompt 模板

本目录存放 html-parser 转换时使用的 LLM Prompt 模板和示例。

---

## LLM Prompt 模板

将以下完整信息发送给大模型：

---

**【LLM 转换 Prompt】**

你是前端架构师，负责将用户提供的原生 HTML（div + 内联样式）转换为项目框架组件代码。

## HTML 类型前置判断（必须先于一切操作执行）

**【强制要求】转换任何内容之前，必须先判断 HTML 类型，不同类型走不同路径：**

```
判断规则：
1. 检查 HTML 中 position: absolute 元素的比例
2. 检查元素 id 是否含有 "数字:数字" 格式的设计工具编号（如 33:17268、42:11956）
3. 检查是否存在 transform: rotate(0deg) + transform-origin: left top 这类 Figma 导出特征

如果满足以下任意一条 → 判定为 Figma 高保真导出：
  ✅ position: absolute 元素占比 > 80%
  ✅ id 属性含有 "数字:数字" 格式
  ✅ 存在 transform-origin: left top 样式

否则 → 判定为普通原生 div
```

**Figma 高保真导出路径（必须严格按此顺序执行）：**

```
第1步：建立坐标映射表（见「绝对定位坐标布局解析规则」）
  → 收集所有元素的 left/top/width/height，按 top 排序
  → 输出坐标映射表，不要跳过这一步

第2步：计算区域边界
  → 确定水平分割点（左栏/右栏 left 临界值）
  → 确定垂直分割点（Header/主体/Footer top 临界值）

第3步：建立视觉层级树
  → 按坐标关系（不是 DOM 嵌套）确定父子关系
  → 明确 Tab 内容区的左栏/右栏归属

第4步：在视觉层级树的基础上做语义推断
  → 参照「语义理解要求」部分

第5步：输出转换代码（见「输出格式」）
```

**禁止的操作（Figma 导出场景）：**
- ❌ 跳过坐标映射表，直接按 DOM 嵌套做语义推断
- ❌ 把 DOM 的父子关系等同于视觉的包含关系
- ❌ 不输出坐标映射表就开始转换

**普通原生 div 路径：**

```
直接进入语义推断 → 按「语义理解要求」处理 → 输出转换代码
（不需要建立坐标映射表）
```

---

## HTML 的作用（必须正确理解）

```
HTML 提供的是：布局参考 + 组件映射
- 布局参考：分栏结构、两栏/三栏、上下布局等
- 组件映射：告诉 LLM 某个区域应该用什么组件（如这里是 Form，那里是 Table）
- 不是：严格还原每个 div 层级和内联样式
```

## 核心约束（必须严格遵守）

```
【最高原则】严格一比一还原：只转换 HTML 和 PRD 中明确存在的内容，禁止自由发挥。

允许：
✅ HTML 中存在的字段 / 按钮 / 布局 → 按原名 / 原文字 / 原结构转换
✅ PRD 中明确要求的字段 / 按钮 / 功能 → 按 PRD 转换
✅ 背景色、padding、margin、border-radius、box-shadow 等重要视觉属性必须提取到 Less

禁止：
❌ 添加 HTML/PRD 中没有的字段或按钮
❌ 合并 / 拆分 / 重排原字段；自行改写字段含义
```

**输出前自检：** 每个字段名、按钮文字、区域数量都必须能在 HTML/PRD 中找到来源；找不到的一律删除。

## 语义理解要求（转换前必须执行）

**【重要】在转换之前，必须先理解 HTML 中每个区域的语义角色，不能只看视觉布局：**

| 视觉特征 | 可能的语义角色 | 判断依据 |
|---------|-------------|---------|
| 左侧面板 | ❌ 侧边栏导航 | 仅当内容是独立功能模块时 |
| 左侧面板 | ✅ 切换器/选项卡 | 当它是服务于右侧主内容的切换控件时 |
| 左侧面板 | ✅ 表单的一部分 | 当它是主表单的某个区块时 |
| 两栏布局 | ❌ 不一定是"导航+内容" | 需根据内容语义判断 |

**判断口诀：**
- 如果左侧内容服务于右侧表单 → 它是**切换器/选项卡**，不是侧边栏
- 如果左侧内容是独立功能菜单，可单独导航 → 才是**侧边栏导航**
- **语义 > 视觉**：由用途决定角色，不由位置决定

## 项目上下文

```
技术栈：<从真实工程扫描出的框架与 UI 方案>
样式方案：<从真实工程扫描出的实际样式方案>
样式文件路径：<跟随目标目录邻近真实文件，不要假定 index.module.less>
Design Token：<如 @primary-color、@border-radius-base>
```

## 项目已有组件（转换时必须跳过）

以下组件在项目中**已有实现**，转换时遇到这些区域**必须跳过，不输出任何代码**：

| 组件名 | 路径 | 说明 |
|--------|------|------|
| Menu | @/components/Menu | 已有菜单组件 |
| Header | @/components/Header | 已有头部组件 |
| Sider | @/components/Sider | 已有侧边栏组件 |
| Footer | @/components/Footer | 已有底部组件 |
| ... | ... | ...（以实际项目为准）|

**跳过规则（必须严格执行）：**

1. **识别已有组件区域**：找到 HTML 中属于已有组件的所有元素（包括容器、标题、背景 wrapper 等）

2. **整个区域一起跳过**：不能只跳过菜单组件本身，必须跳过包含它的整个区域
   - ❌ 错误：只跳过 `<nav>` 或 `<ul>` 菜单元素，但保留了外层 `<div class="menu-wrapper">` 的样式
   - ✅ 正确：跳过 `<div class="menu-wrapper">` 整个区域，包括它的背景、padding、标题等所有样式

3. **如何判断是否跳过**：如果一个区域的父容器是已有组件，则整个区域都不输出

4. **只转换项目没有的部分**：内容区、表单、列表、新增的业务组件等

## 用户提供的 HTML

```html
<HTML 完整内容粘贴在此>
```

## PRD 任务内容（用于替换占位符）

```
<PRD 中提取的任务名称、字段列表、按钮文字等>
```

## 转换要求

### 内容边界规则

```
HTML 负责：布局框架、整体结构、元素位置、间距分布（必须完全遵循）
PRD 负责：文案内容、字段名称、按钮文字、小细节优化

边界优先级：HTML 布局 > PRD 细节
```

### CSS 布局属性必须保留在 Less 中

以下 CSS 属性**必须原样保留**，不能用框架组件替代：

| CSS 属性 | 说明 | 错误做法 |
|---------|------|---------|
| `display: flex` | Flex 容器 | ❌ 用框架 Flex 组件替代 |
| `display: grid` | Grid 布局 | ❌ 尝试用其他组件替代 |
| `flex-direction` | 主轴方向 | ❌ 省略或改变方向 |
| `justify-content` | 主轴对齐 | ❌ 省略或改变 |
| `align-items` | 交叉轴对齐 | ❌ 省略或改变 |
| `gap` | 间距 | ❌ 省略间距 |
| `flex: 1` | 拉伸权重 | ❌ 省略或用固定宽度替代 |
| `overflow` | 溢出处理 | ❌ 省略滚动逻辑 |
| `max-height` | 最大高度限制 | ❌ 省略，配合 overflow 使用 |

### 样式保留边界（针对高保真 HTML）

- 源 HTML 已有的 `display`、`flex-direction`、`justify-content`、`align-items`、`gap`、`overflow`、`max-height` 等样式信号，转换时优先保留
- 不要为了“更工整”或“更工程化”擅自改轴、删样式、换对齐方式或重排原始层级
- 高保真 HTML 的颜色、边框、圆角、背景、阴影、间距和对齐关系都属于视觉契约，不能在转换时随意丢失
- 宽高尽量避免层层写死；能通过父级尺寸、百分比、`flex: 1`、`width: 100%`、`height: 100%` 等继承关系表达的，优先用继承关系

### Tab 内容区布局转换规则（必须严格执行）

**常见问题：LLM 会把 Tab 内容区里的左右布局元素搬到 Tab 外面，或合并成单栏，或丢失背景色。**

**转换规则：**

1. **Tab 结构必须保留**：
   ```
   HTML: <div class="tabs"><div class="tab-content"><div class="left">左</div><div class="right">右</div></div></div>
   正确: <Tabs><Tabs.TabPane tab="标签1"><Row gutter={16}><Col span={12}>左</Col><Col span={12}>右</Col></Row></Tabs.TabPane></Tabs>
   错误: <Tabs>...左...右...</Tabs>  ← 左右元素被搬到 Tab 外面
   错误: <Row><Col>左</Col><Col>右</Col></Row>  ← 没有包在 Tab 里面
   ```

2. **Tab 内容区的左右布局必须包在 Tab 组件内部**：
   - 左右元素是 Tab 内容的一部分，不能独立于 Tab 之外
   - 两栏/三栏布局用 `<Row>` + `<Col>` 实现，但必须在 Tab 的 `<TabPane>` 内部

3. **禁止的操作**：
   - ❌ 把 Tab 内容区的左右元素提取到 Tab 外面
   - ❌ 省略 Tab 组件，直接渲染内容
   - ❌ 把两栏布局改成单栏平铺
   - ❌ 改变元素在 Tab 内容区的嵌套层级
   - ❌ 省略 Tab 内容区的背景色、padding 等样式

4. **Tab 内容区的背景色必须保留**：
   ```
   HTML: <div class="tab-content" style="background: #fff; padding: 16px;">
   正确: <Tabs.TabPane><div className={styles.tabContent}>...</div></Tabs.TabPane>
   Less: .tabContent { background: @white; padding: 16px; }
   ```

### 复杂标题区域转换规则

**常见问题：** 标题区域的背景色、边框、间距等视觉属性容易丢失。

识别特征：包含标题文字的容器；通常带背景、padding、下边框；className 含 `title`、`header`、`page-title`。

转换要求：

- 背景色 / padding / border-bottom 必须完整提取到 Less，不能省略或替换为其他元素
- 标题区域若含操作按钮，保持父子结构和 `display: flex / justify-content / align-items`

```
HTML: <div class="page-title" style="background: #f5f5f5; padding: 16px 24px; border-bottom: 1px solid #e8e8e8;">
正确: <div className={styles.pageTitle}>标题</div>
Less: .pageTitle { background: @background-light; padding: 16px 24px; border-bottom: 1px solid @border-color; }
```

### 复杂 Tab 切换区转换规则

**常见问题：** Tab 切换区的样式（背景色、选中态、下边框）被忽略。

识别特征：多个 `tab-item` 类容器，可能含 `active` / `selected` 状态。

要求：

- 用 AntD `Tabs` 的 `items` 属性实现；选中态优先靠主题变量（`@tabs-ink-bar-color` 等）
- 自定义样式提取到 Less，通过 `className` 套到 `<Tabs>` 上

### 纯 div 无语义元素 HTML 转换规则

**触发条件：HTML 为纯原生 div（所有元素都是 `<div>`，无 `<button>`、`<input>`、`<span>` 等语义元素）**

**详细规则见：** `view references/html-templates/pure-div-converter.md`

**作用：** 通过 className、内联样式、嵌套关系、文字内容综合判断元素类型，进行语义推断转换。

**必须遵守的约束：**
- 背景色必须归属到实际元素，禁止放到 `::after` 伪元素
- 必填标志 `*` 转换规则（**label 消失是高频错误，必须重点检查**）：
  ```
  HTML: <div>*课程名称</div>

  正确转换（三步缺一不可）：
    第1步：去掉 * → label 文字 = "课程名称"
    第2步：label 文字必须原样写进 Form.Item 的 label 属性
    第3步：加 required={true}

  <Form.Item label="课程名称" required rules={[{required:true}]}>
    ↑ label 必须有文字，不能为空或省略

  高频错误（❌ 绝对禁止）：
  ❌ <Form.Item required>         ← label 消失，字段标题没了
  ❌ <Form.Item label="*课程名称" required>  ← 显示两个 *
  ```
- 字段名称必须一比一还原 PRD，禁止自行添加限定词（如"关键人职位"而非"职位"）
- Tab 内容区左右栏边界必须严格遵守 left 坐标，禁止把右栏内容放到左栏

**生成代码后必须自检（必填字段逐个过）：**
```
对每一个以 * 开头的 div 文本，检查转换后的 Form.Item：
[ ] label 属性是否存在且有文字？
[ ] required 是否为 true？
[ ] label 里是否有残留的 * 号？
如果任意一项不符合 → 立即修正，不能遗留
```

### 绝对定位坐标布局解析规则

**触发条件：HTML 使用绝对定位（position: absolute）**

**详细规则见：** `view references/html-templates/pure-div-converter.md`

**作用：** 通过坐标映射建立视觉层级，保持 DOM 结构与视觉结构一致。

---

## 结构转换规则

**原则：实现与高保真 HTML 等价的框架代码，不是机械还原 div 结构，也不是生搬组件默认外观**

| HTML 区域类型         | → React + AntD        | → Vue + Element Plus   | 说明                    |
| --------------------- | --------------------- | ---------------------- | ----------------------- |
| 表单区域              | `<Form>` + `<Form.Item>` | `<el-form>`          | 使用表单组件            |
| 表格区域              | `<Table>` + columns  | `<el-table>`          | 使用表格组件            |
| 弹窗区域              | `<Modal>`            | `<el-dialog>`         | 使用弹窗组件            |
| 抽屉区域              | `<Drawer>`           | `<el-drawer>`         | 使用抽屉组件            |
| 标签页区域            | `<Tabs>`             | `<el-tabs>`           | 使用标签页组件          |
| 输入框                | `<Input>`            | `<el-input>`          | 使用输入框组件          |
| 下拉选择              | `<Select>`           | `<el-select>`         | 使用选择组件            |
| 按钮                  | `<Button>`           | `<el-button>`         | 使用按钮组件            |
| 布局容器（分栏、间距）| `<Row>` + `<Col>`    | `<el-row>` + `<el-col>` | 使用栅格组件           |
| div 容器              | `<div className={styles.xxx}>` | `<div class="xxx">` | 仅作为布局辅助，不影响语义 |

**不要这样做：**
- ❌ 把 `<div>` 当作主要布局元素，用一堆 `<div>` 嵌套实现布局
- ❌ 保留 HTML 原有的复杂 div 结构

**应该这样做：**
- ✅ 用 `<Row>`/`<Col>` 栅格实现分栏
- ✅ 用 `<Form>` 实现表单布局
- ✅ 用 `<Table>` 实现表格
- ✅ 用 `<Tabs>` 实现标签页
- ✅ 在使用组件前先反推关键 props / mode / layout，并补足必要样式
- ✅ 父容器已经提供宽高时，子容器优先继承、拉伸或按比例分配，不要层层写死尺寸

### 组件属性反推规则

对每个准备替换成组件的区域，先确认：

1. 候选组件是什么
2. 关键 props / mode / layout 是什么
3. 需要补哪些样式才能贴近原稿
4. 如果默认组件行为与原稿冲突，是否应该回退到更小槽位或保留自定义结构

高风险示例：

- 彩色小圆点 + 状态文本：
  - 若没有完整 pill 背景和边框，不要直接用 `Tag`
  - 优先 `Badge` 或自定义 dot + text 结构
- 上下布局且无边框的详情说明块：
  - 只有 `Descriptions` 的 `layout`、`column`、`bordered` 等配置能贴近原稿时才允许用
  - 否则保留自定义 label-value 结构
- 条状百分比进度：
  - 必须优先 `Progress type="line"`
  - 只有存在明确圆形或仪表盘几何特征时才允许 `circle` / `dashboard`
- 同一行原子内容：
  - 数字 + 单位、金额 + 币种、数值 + `%`、主值 + 短尾缀，如果原稿在同一视觉行，转换后也必须保持同一行
  - 如有必要，显式补 `white-space: nowrap`、`inline-flex`、`align-items: baseline`、`gap`
- 大布局容器：
  - 页面主内容、左右分栏、上下区块优先使用 `flex` / `grid` / 百分比 / `minmax`
  - 若父元素已定义宽高，子元素优先 `flex: 1`、`width: 100%`、`height: 100%`、`align-self: stretch`
  - 固定宽高只用于确实需要锁定的局部视觉盒子，不要整页层层硬编码

---

## 输出格式

LLM 返回内容后，由**调用方（html-parser 技能）负责提取并写入文件**，LLM 无需自行写文件，只需输出结构化内容供提取。

### 强制输出标记（必须包含）

LLM 转换完成后，**必须**在返回内容中包含以下两个代码块（即使某部分为空也要输出占位标记）：

```tsx
// [TASK_TSX_FILE]
// 文件路径：<real project page file path>
// import 和样式引用方式必须跟随真实工程邻近文件

const Page = () => (
  <div>
    {/* 组件结构 */}
  </div>
);
// [/TASK_FRAMEWORK_FILE]
```

```text
// [TASK_STYLE_FILE]
// 文件路径：<real project style file path>
.pageWrapper {
  /* style content follows the real project style format */
}
// [/TASK_STYLE_FILE]
```

**重要：**
- `[TASK_TSX_FILE]` 和 `[TASK_LESS_FILE]` 是提取标记，**必须保留**
- LLM 只需生成这两个代码块内容，不要自行执行 Write 命令
- 调用方读取 LLM 返回内容 → 提取代码块 → 写入文件

---

## 降级输出格式（无文件系统环境）

**触发条件：** 在 claude.ai 对话模式中运行，无法写入文件时使用此格式。

当无法使用 `[TASK_TSX_FILE]` 标记写入文件时，**直接以标注路径的代码块形式输出**：

```
【html-parser 降级输出 - 请手动复制以下代码到工程目录】

目标路径：<real project page file path>
```text
// 转换后的框架代码（完整）
```

目标路径：<real project style file path>
```text
// 转换后的样式代码（完整）
```
```

**降级模式注意事项：**
- 代码必须完整，不能省略 import 或组件定义
- 路径注释必须明确，方便手动复制
- 不需要输出 `[TASK_TSX_FILE]` 标记（标记在无文件系统环境下无意义）

---

## 验证步骤

LLM 转换完成后，**必须执行以下验证**：

```bash
# 1. 验证 Less 类名是否存在
grep -E "\.pageWrapper|\.searchBar" <real project style file path>

# 2. 验证组件中引用的 className 与 Less 一致
grep -E "className=\{styles\." <real project page file path>

# 3. 验证没有遗漏的内联 style
grep -E "style=\{\{" <real project page file path> | grep -v "placeholder\|value"

# 4. 验证框架组件使用正确
grep -E "<Table|<Form|<Input|<Button|<Modal|<Drawer" <real project page file path>
```





