---
name: 财富w+
description: A PC-side wealth business UI system based on Ant Design 5 defaults, Less CSS Modules, dense desktop layouts, and practical enterprise component conventions.
category: Core
source: custom
license: internal
---

# UI 系统设计

## 设计令牌

### 字体

| 令牌 | 值 | 使用场景 |
| --- | --- | --- |
| 字体族 | `Microsoft YaHei, UnCommFont` | 全局字体，定义在 `index.css` |
| 字号基础 | `14px` | Ant Design 默认字号 |
| 字号标题 | `16px ~ 20px` | 页面标题、卡片标题 |
| 字号小号 | `12px` | 辅助文字、标签 |

### 颜色

项目未定义全局 CSS 变量，颜色值分散在组件样式中。Ant Design 5 的 Design Token 通过 ConfigProvider 可全局配置，但目前未显式配置。

| 用途 | 常见值 | 来源 |
| --- | --- | --- |
| 主色 | `#1677ff` | Ant Design 5 默认蓝色 |
| 链接色 | `#1677ff` | Ant Design 默认 |
| 成功色 | `#52c41a` | Ant Design 默认 |
| 警告色 | `#faad14` | Ant Design 默认 |
| 错误色 | `#ff4d4f` | Ant Design 默认 |
| 文字主色 | `#333` / `rgba(0,0,0,0.88)` | 项目常见 |
| 文字次要 | `#666` / `#999` | 项目常见 |
| 边框色 | `#e8e8e8` / `#d9d9d9` | 项目常见 |
| 背景色 | `#f5f5f5` / `#fff` | 项目常见 |

### 间距

项目使用 `common.module.less` 中定义的间距工具类：

| 类名 | 值 | 说明 |
| --- | --- | --- |
| `.mt10` / `.mb10` / `.ml10` / `.mr10` | `10px` | 小间距 |
| `.mt20` / `.mb20` / `.ml20` / `.mr20` | `20px` | 中间距 |
| `.mg10` | `10px` | 四周小间距 |
| `.mg20` | `20px` | 四周中间距 |

## 布局密度

页面布局使用 Ant Design Row / Col 栅格系统。

卡片组件使用 Ant Design Card 组件。

弹窗使用 Ant Design Modal / Drawer。

Flex 布局工具类定义在 `common.module.less` 中。

### Flex 工具类

| 类名 | 说明 |
| --- | --- |
| `.flex` | `display: flex` |
| `.flex_ac` | `display: flex; align-items: center` |
| `.flex_space` | `display: flex; justify-content: space-between` |
| `.flex_just_space` | `flex + align-items: center + justify-content: space-between` |
| `.flex_just_center` | `flex + align-items: center + justify-content: center` |
| `.flex_just_around` | `flex + align-items: center + justify-content: space-around` |
| `.flex_col` | `flex-direction: column` |
| `.flex_col_center` | `flex-direction: column + align-items: center + justify-content: center` |
| `.flex_col_space` | `flex-direction: column + justify-content: space-between` |

## 组件状态

项目组件遵循以下状态约定：

| 状态 | 说明 | 示例 |
| --- | --- | --- |
| 默认 | 组件初始展示状态 | 按钮默认样式、输入框空值 |
| 悬停 | 鼠标悬停 | 按钮 hover 变色、卡片阴影 |
| 选中 | 被选中状态 | MyButton 的 selected 样式、MyRadio 的 checked 样式 |
| 禁用 | 不可交互 | Ant Design 组件原生 disabled 属性 |
| 加载 | 数据加载中 | Ant Design Spin、Skeleton |
| 空态 | 无数据 | 列表无数据时展示 |
| 错误 | 异常状态 | 接口请求失败提示 |

## 响应式行为

项目为 PC 端应用，主要面向 1024px+ 分辨率。

未实现移动端适配。

卡片布局使用固定宽度（如 PcCardComponent 的 previewWidth 默认 415px）。

页面内容区域通过 Ant Design Row / Col 实现弹性布局。

## 无障碍

项目未显式配置无障碍属性。

Ant Design 5 组件内置基础 ARIA 支持。

图片使用 alt 属性（部分组件未设置）。

颜色对比度依赖 Ant Design 默认值。

## 样式约定

| 规则 | 说明 |
| --- | --- |
| 样式方案 | Less CSS Modules（`.module.less`） |
| 类名风格 | camelCase（CSS Modules 自动转换） |
| 全局样式 | 放在 `src/index.css` 或 `src/common/css/common.module.less` |
| 组件样式 | 与组件同目录的 `index.module.less` 或 `style.module.less` |
| 禁止 | 禁止使用 `!important`（除非覆盖第三方组件） |
| 禁止 | 禁止在 JSX 中使用内联 style 对象（动态样式除外） |
