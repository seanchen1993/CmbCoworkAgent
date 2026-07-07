---
name: 市场w+
description: A PC-side enterprise design system based on deeply customized Ant Design patterns, with AI visual elements and #1774FF as the primary brand color.
category: Core
source: custom
license: internal
---

# 系统 PC 端深度设计规范

本规范基于 Ant Design 进行深度定制，结合业务场景对核心组件的视觉与交互细节进行了标准化定义，并融入了 AI 业务场景的视觉元素规范。品牌主色统一为 **#1774FF**。

---

## 1. 全局视觉基调 (Global Visual Baseline)

* **品牌色体系:**
  * **Primary:** `#1774FF` (主色，用于主要按钮、状态、选中态等)
  * **Success:** `#52C41A` (成功)
  * **Warning:** `#FAAD14` (警告)
  * **Error:** `#F5222D` (错误)
  * **Info:** `#1774FF` (信息)
* **AI 视觉元素规范 (AI Visual Elements):** —— *新增（提取自示例页面）*
  * **AI 渐变色:** 采用品牌色至紫色/浅蓝的线性渐变。
    * 标准渐变：`linear-gradient(90deg, #1774FF 0%, #7B61FF 100%)`
  * **AI 背景样式:**
    * **微光背景:** 背景可采用品牌色与紫色的极浅色渐变或弥散光效果，增加空间感。
    * **纹理底纹:** 支持使用微弱的网格线或 AI 字符阵列底纹（不透明度建议 2%-5%），强化科技感氛围。
  * **AI 专属标识:** 统一使用闪烁图标（Sparkle Icon）作为 AI 能力的标识。
  * **高亮投影:** AI 相关的卡片或按钮在 Hover 状态下可使用带渐变色的扩散投影（Spread Shadow）。
* **中性色体系:**
  * **标题/正文:** `#262626` (一阶文本) / `#595959` (二阶正文)
  * **次要/辅助:** `#8C8C8C` (占位符、失效文字)
  * **边框/分割线:** `#D9D9D9` (描边) / `#F0F0F0` (轻分割)
  * **背景色:** `#F5F5F5` (页面底色) / `#FFFFFF` (容器底色)
* **网格与圆角:**
  * **基础步进:** 8px 步进网格 (4, 8, 16, 24, 32...)
  * **圆角规范:** 标准 **4px**；小圆角 **2px**。

---

## 2. 深度组件规范 (Component Deep Dive)

### 2.1 滚动条 (Scroll)

* **样式分类:** 大滚动条 (10px, r=5px)；小滚动条 (6px, r=3px)。
* **视觉状态:** 轨道透明；滑块默认背景 `#BFBFBF` (40% 不透明度)，Hover 后提升至 60%，Active 时 80%。

### 2.2 按钮 (Button)

* **AI 特色样式:** 核心 AI 功能触发按钮（如“开始”、“生成”）可采用 **AI 渐变色** 背景，配合 4px 标准圆角及白色文字。
* **常规样式:** Primary, Default, Dashed, Link/Text, Ghost。
* **对齐:** 弹窗/抽屉右对齐；单行表单左对齐。间距固定为 **8px**。

### 2.3 输入框 (Input)

* **特性:** 支持前/后缀 Icon 与标签组合；右下角实时显示字数限制。
* **金额模式:** 数值右对齐，格式化为千分位。

### 2.4 表格 (Table)

* **交互:** 鼠标悬浮行变色 (`#F5F9FF`)；支持左右固定列及阴影过渡。

### 2.5 选择器 (Select) & 树选择 (TreeSelect)

* **Select:** 支持 Tags 模式折叠。
* **TreeSelect:** 支持线条模式强化层级视觉动线。

### 2.6 头像 (Avatar)

* **类型:** Icon、图片、字符（五种随机色背景）。
* **尺寸:** 大尺寸 (36x36px)、小尺寸 (28x28px)。

### 2.7 空状态 (Empty)

* **应用:** 数据为空、搜索无结果等。包含插画、标题、描述及引导按钮。

### 2.8 描述列表 (Descriptions)

* **布局:** 水平、表格型 (行高 40px)、垂直。

---

## 3. 交互与反馈规范

1. **AI 响应即时性:** AI 生成过程中必须提供明确的视觉反馈，如：
   * **呼吸灯效果:** 背景或边框的规律性明暗变化。
   * **流式加载:** 文本显示支持打字机效果。
2. **加载反馈 (Loading):** 超过 0.5s 的异步请求必须显示 Loading。
3. **防错设计:** 所有不可逆或高风险操作必须通过 Modal 或 Popconfirm 确认。
4. **即时响应:** Hover 和点击动作需在 0.1s 内提供视觉反馈。

# End of Specification Document v12
