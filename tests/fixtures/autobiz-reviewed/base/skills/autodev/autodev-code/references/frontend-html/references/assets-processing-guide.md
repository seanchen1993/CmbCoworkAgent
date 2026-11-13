---
name: assets-processing-guide
description: 高保真 HTML 中 assets 资源的检查、判定、映射与复制规则。适用于 with-absolute-html 和 with-standard-html 两条路线，在读取顺序完成后、编码前简报之前执行。
---

# Assets 资源处理指南

本文档定义高保真 HTML 压缩包中 `assets/` 文件夹的统一处理规则，适用于绝对定位路线和标准 HTML 路线。

## 1. 执行时机

**在以下两个阶段之间执行：**
- **之后**：完成 HTML 读取、项目上下文读取、组件库确认
- **之前**：编码前简报（Craft）、实际代码实现

**触发条件：**
当高保真 HTML 压缩包中包含 `assets/` 文件夹时，必须执行本流程。

## 2. 检查 assets 目录

### 2.1 扫描资源文件

1. 解压高保真压缩包后，检查是否存在 `assets/` 文件夹。
2. 若存在，读取原始 HTML 文件，提取所有引用了 `assets/` 目录的资源文件路径。
3. **重要：仅处理 HTML 中实际引用的资源文件，未被引用的文件无需处理。**
4. 对每个被引用的文件，记录：
   - 文件名（保持原始文件名，包括中文）
   - 文件类型（SVG、PNG等）
   - 文件大小
   - 在原始 HTML 中的引用位置和语义

**引用检测方法：**
- `<img src="./assets/文件名.svg" />` - 图片标签引用
- `<img src="./assets/文件名.png" />` - 位图引用
- CSS `background-image: url(./assets/文件名.jpg)` - 背景图引用
- 其他通过相对/绝对路径引用 `assets/` 目录的情况

### 2.2 语义识别

通过以下方式判断每个**被引用的** asset 的用途：
- 文件名中的关键词（箭头、用户、图标、Logo、AI等）
- 在 HTML 中的 `<img>` 标签的 `alt` 属性
- 在 HTML 中的上下文位置（header、nav、button等）
- 视觉特征（品牌色、特殊形状、装饰性等）

## 3. 图标资源优先级判定

**重要前提：仅对 HTML 中实际引用的 assets 文件进行优先级判定和处理。**

对 `assets/` 中每个**被 HTML 引用的**图标文件，按以下优先级判断是否需要使用：

### 优先级1：使用 Ant Design / Ant Design Mobile 图标库 ✅

**适用场景：**
- 通用 UI 图标（箭头、关闭、搜索、设置、用户、下拉等）
- 标准操作图标（编辑、删除、添加、刷新等）
- 常见状态图标（成功、失败、警告、信息等）

**判定方法：**
1. 检查图标语义（通过文件名或上下文判断）
2. 在 `@ant-design/icons` 或 `antd-mobile/icons` 中查找对应图标
3. 若找到语义匹配的图标，记录映射关系并使用库图标

**常见映射示例：**
| 文件名特征 | 语义 | Ant Design 图标 |
| --- | --- | --- |
| 箭头_右、arrow-right | 右箭头 | `<RightOutlined />` |
| 箭头_下、down-arrow | 下箭头 | `<DownOutlined />` |
| 用户、user、头像 | 用户图标 | `<UserOutlined />` |
| 搜索、search | 搜索 | `<SearchOutlined />` |
| 设置、setting | 设置 | `<SettingOutlined />` |
| 关闭、close | 关闭 | `<CloseOutlined />` |
| 编辑、edit | 编辑 | `<EditOutlined />` |
| 删除、delete | 删除 | `<DeleteOutlined />` |

**处理方式：**
- 不复制该 asset 文件到项目
- 在代码中使用 Ant Design 图标组件
- 若需调整颜色/大小，使用 `style` 或 `className`

### 优先级2：使用项目已有图标体系 ✅

**适用场景：**
- 项目已有统一的图标管理方式（如 `src/assets/icons/`、`components/Icon/`）
- assets 中的图标与项目已有图标重复或类似

**判定方法：**
1. 检查项目 `src/assets/icons/`、`components/Icon/`、`public/icons/` 等目录
2. 查找是否已有相同语义或相似设计的图标
3. 若找到，复用项目图标而非新增 assets

**处理方式：**
- 不复制该 asset 文件到项目
- 在代码中引用项目已有图标
- 记录复用关系

### 优先级3：CSS 实现简单图形 ✅

**适用场景：**
- 纯色矩形、圆形、三角形等简单几何图形
- 直线、虚线、分隔线等装饰元素
- 纯色背景块

**判定方法：**
1. 分析 SVG/图片内容是否为简单几何图形
2. 判断是否可用 CSS `border`、`border-radius`、`background` 等实现

**常见 CSS 替代方案：**
| 原 asset | 语义 | CSS 实现方案 |
| --- | --- | --- |
| 分隔线.svg | 垂直/水平分隔线 | `<div className="w-px h-full bg-gray-300" />` |
| 矩形.svg | 装饰矩形 | `<div className="w-4 h-4 bg-blue-500 rounded" />` |
| 圆点.svg | 圆点标记 | `<div className="w-2 h-2 rounded-full bg-red-500" />` |
| 三角形.svg | 下拉三角 | `border` 三角形技巧或 CSS `clip-path` |

**处理方式：**
- 不复制该 asset 文件到项目
- 在代码中使用 CSS 实现
- 记录 CSS 实现方案和样式类名

### 优先级4：保留 assets 中的特殊设计 ✅

**适用场景（仅在以下情况下保留）：**
- 品牌 Logo（公司 Logo、产品 Logo）
- 品牌特殊设计图标（带有品牌色、特殊形状、自定义插画风格）
- 异形图标（无法在图标库中找到合适替代）
- 业务专属图标（特定领域的图标，如行业特有符号）
- 复杂插画、装饰图案
- 产品功能截图、示意图

**判定标准：**
- **仅当**无法用图标库、项目已有图标或 CSS 实现时，才保留
- 预期保留的 assets 文件应 **≤ 30%** 的原始文件数量

**处理方式：**
- 将文件复制到项目的 assets 目录
- 保持原始文件名（包括中文文件名），不要重命名
- 记录引用路径供后续实现使用

## 4. Assets 使用映射表

编码前必须创建 assets 使用映射表，格式如下：

| 原始文件 | 语义 | 处理方式 | 替代方案 | 理由 |
| --- | --- | --- | --- | --- |
| `1.箭头_方向箭.svg` | 右箭头 | 使用Antd图标 | `<RightOutlined className="text-[#5C69FF]" />` | 通用图标，图标库已有 |
| `A-线性图标_【常规图标】_【展开】down-line.svg` | 下拉箭头 | 使用Antd图标 | `<DownOutlined className="w-4 h-4" />` | 通用图标，图标库已有 |
| `编组_用户.svg` | 用户图标 | 使用Antd图标 | `<UserOutlined />` | 通用图标，图标库已有 |
| `AI.svg` | AI 标识 | 复制到项目assets | `import AIIcon from '@/assets/icons/AI.svg'` | 品牌特殊设计，无替代 |
| `编组_39.svg` | 品牌 Logo | 复制到项目assets | `import Logo from '@/assets/images/logo.svg'` | 品牌 Logo，必须保留 |
| `矩形_85.svg` | 装饰直线 | CSS实现 | `<div className="w-full h-px bg-[#E5E7EB]" />` | 简单几何图形 |

**映射表必须包含：**
1. 原始文件名（完整路径）
2. 语义识别结果
3. 处理方式决策（四选一）
4. 替代方案的具体代码
5. 决策理由

## 5. 复制必要的 assets

**重要：** `process_assets.py` 脚本会自动执行文件复制。脚本执行后，映射表中标记为"复制到项目assets"的文件已经被复制到项目目录。

仅将映射表中标记为"复制到项目assets"的文件执行以下操作：

### 5.1 确定目标目录

根据项目结构和 asset 类型确定目标目录：

**常见项目结构：**
- `src/assets/icons/` - 图标类
- `src/assets/images/` - 图片类
- `src/assets/logos/` - Logo 类
- `public/assets/` - 静态资源（需通过 URL 访问）

**选择规则：**
- 优先使用项目已有的 assets 组织方式
- 若项目无明确规则，使用 `src/assets/` 并按类型分类
- 需要通过 URL 直接访问的资源放 `public/`

### 5.2 复制文件

1. 将文件复制到目标目录
2. **保持原始文件名**（包括中文文件名），不要重命名
3. 若文件名冲突，在文件名后添加语义后缀（如 `Logo_首页.svg`）

### 5.3 记录引用路径

为每个复制的文件记录引用路径：

**使用项目别名（推荐）：**
```typescript
import AIIcon from '@/assets/icons/AI.svg';
import Logo from '@/assets/images/编组_39.svg';
```

**使用相对路径：**
```typescript
import AIIcon from '../../assets/icons/AI.svg';
```

**使用 public 路径：**
```typescript
<img src="/assets/images/logo.svg" alt="Logo" />
```

### 5.4 在代码中正确引用

**React/Vue 项目：**
```tsx
// SVG 作为 React 组件（需配置 SVGR）
import { ReactComponent as AIIcon } from '@/assets/icons/AI.svg';
<AIIcon className="w-6 h-6" />

// SVG 作为图片
import AIIconUrl from '@/assets/icons/AI.svg';
<img src={AIIconUrl} alt="AI" className="w-6 h-6" />

// PNG/JPG
import LogoImage from '@/assets/images/logo.png';
<img src={LogoImage} alt="Logo" />
```

**注意事项：**
- 检查项目的 webpack/vite 配置，确认 SVG 处理方式
- 若项目已配置 SVGR，优先使用组件方式引入 SVG
- 为 `<img>` 标签添加合适的 `alt` 属性

## 6. Assets 处理总结

在进入编码前简报之前，必须输出 assets 处理总结：

```markdown
### Assets 处理总结

- HTML 中引用的 assets 文件总数：15 个（assets 目录中可能有更多文件，但仅处理被引用的）
- 使用 Ant Design 图标替代：10 个（67%）
  - `1.箭头_方向箭.svg` → `<RightOutlined />`
  - `A-线性图标_【常规图标】_【展开】down-line.svg` → `<DownOutlined />`
  - `编组_用户.svg` → `<UserOutlined />`
  - ...
- 使用项目已有图标：0 个
- CSS 实现：3 个（20%）
  - `矩形_85.svg` → `<div className="w-full h-px bg-[#E5E7EB]" />`
  - `分隔线_vertical.svg` → `<div className="w-px h-full bg-gray-300" />`
  - ...
- 复制到项目 assets：2 个（13%）✅
  - `AI.svg` → `src/assets/icons/AI.svg`
  - `编组_39.svg` → `src/assets/images/编组_39.svg`（品牌 Logo）

✅ 保留率 13% ≤ 30%，符合建议范围。

**注意：assets 目录中未被 HTML 引用的文件（如有）已自动忽略，不计入统计和处理。**
```

**检查点：**
- 若超过 30% 的**被引用** assets 被标记为"复制到项目"，**建议重新审查判定标准**
- 重新检查是否有遗漏的图标库替代方案
- 重新评估是否有可用 CSS 实现的简单图形
- 确认每个"复制到项目"的决策是否必要

## 7. 集成到编码前简报

Assets 处理总结必须作为编码前简报的一部分：

```markdown
## 4. 编码前简报

### 4.1 源 HTML 范围
- 原始 HTML：首页.html
- 外部资源：assets/ 文件夹（15个文件）
- **Assets 处理结果**：
  - 使用 Ant Design 图标：10 个
  - CSS 实现：3 个
  - 复制到项目：2 个（AI.svg, Logo）

### 4.2 依赖与资源
- 必需依赖：`@ant-design/icons`（已安装）
- 新增 assets：
  - `src/assets/icons/AI.svg`
  - `src/assets/images/编组_39.svg`

### 4.3 组件映射计划
- 右箭头图标：`<RightOutlined />` 替代 `1.箭头_方向箭.svg`
- AI 标识：`<img src={AIIcon} />` 使用项目 assets
- ...
```

## 8. 常见问题

### Q1: 如何判断一个图标是否是"品牌特殊设计"？

**判断标准：**
- 包含品牌专属颜色（非通用色）
- 包含品牌专属形状或元素
- 具有自定义插画风格
- 在图标库中找不到语义接近的替代

**示例：**
- ✅ 品牌特殊设计：带品牌色的 AI 标识、公司 Logo
- ❌ 非特殊设计：纯黑色的右箭头、通用的用户图标

### Q2: Ant Design 图标颜色不匹配怎么办？

**解决方案：**
- 使用 `style` 属性：`<RightOutlined style={{ color: '#5C69FF' }} />`
- 使用 `className`：`<RightOutlined className="text-[#5C69FF]" />`
- 优先使用 className，符合 Tailwind 项目规范

### Q3: 如果图标库中没有完全匹配的图标，但有类似的，应该用哪个？

**决策流程：**
1. 如果语义完全匹配，视觉略有差异 → 使用图标库（优先级1）
2. 如果语义接近，但视觉差异明显 → 使用 assets（优先级4）
3. 不确定时，倾向于使用图标库，理由：
   - 保持整体图标风格统一
   - 减少资源文件数量
   - 便于后续维护

### Q4: 中文文件名会导致问题吗？

**建议：**
- 在项目内部使用时，保持中文文件名没有问题
- 大多数现代构建工具（webpack、vite）都支持中文文件名
- 若项目明确要求英文文件名，在复制时统一重命名，并在映射表中记录新旧文件名对应关系

### Q5: 30% 保留率的边界条件？

**计算方式：**
- 保留率 = 复制到项目的文件数 / HTML 中实际引用的 assets 文件总数
- 示例：HTML 引用了 15 个 assets 文件，建议保留不超过 5 个（33%）
- **注意：assets 目录中未被 HTML 引用的文件不计入分母**

**边界处理：**
- 若为 28%，在建议范围内
- 若为 35%，建议重新审查，尝试减少 1-2 个
- Logo 和品牌特殊设计是必须保留的，优先替换其他可疑项

## 9. 检查清单

在完成 assets 处理后，使用以下清单确认：

- [ ] 已从 HTML 中提取所有引用的 assets 文件路径
- [ ] 已确认仅处理被 HTML 引用的资源文件，未引用的文件已忽略
- [ ] 已对每个被引用的 asset 进行语义识别
- [ ] 已按四级优先级对每个被引用的 asset 做出处理决策
- [ ] 已创建完整的 assets 使用映射表
- [ ] 图标库替代方案已验证可用（检查 package.json 中是否安装 `@ant-design/icons`）
- [ ] CSS 实现方案已记录具体代码
- [ ] 保留率 ≤ 30%（基于被引用的文件数计算）
- [ ] `process_assets.py` 脚本已自动复制必要的 assets 到项目目录
- [ ] 已验证复制结果（检查脚本输出的 `copiedCount` 和 `failedCount`）
- [ ] 已记录所有复制文件的引用路径
- [ ] Assets 处理总结已输出，并明确说明未引用文件的处理情况
- [ ] Assets 处理结果已集成到编码前简报

## 10. 与两条路线的集成

### 10.1 在 with-absolute-html 路线中的位置

插入到 `html-parser.md` 的第 4 节"读取输入"之后、第 5 节"技术栈确认"之前：

```markdown
## 4. 读取输入
...

## 4.5 Assets 资源处理

执行 `../references/assets-processing-guide.md` 中定义的完整流程：
1. 检查并扫描 assets 目录
2. 对每个 asset 执行四级优先级判定
3. 创建 assets 使用映射表
4. 复制必要的 assets 到项目目录
5. 输出 assets 处理总结

Assets 处理总结将作为后续"编码前简报"的输入材料。

## 5. 技术栈确认
...
```

### 10.2 在 with-standard-html 路线中的位置

已插入到 `standard-html-parser.md` 的第 3 节"读取顺序"之后、第 4 节"编码前简报"之前：

```markdown
## 3. 读取顺序
...

## 3.1 Assets 资源检查与处理

执行 `../../references/assets-processing-guide.md` 中定义的完整流程。
（详见该文件）

## 4. Craft：编码前简报
...
```
