# 页面原型

## detail-page

信号：

- 单主内容列
- 多个字段区块
- 没有明显独立右侧栏

需要提取：

- 内容宽度
- 字段块模式
- section 顺序
- footer 动作位置

## detail-page-with-rail

信号：

- 主内容 + 独立右侧栏或侧边卡片堆叠
- 右侧栏包含时间线、审批卡、摘要或工具

需要提取：

- 主内容宽度
- 右侧栏宽度
- 栏间距
- 桌面 / 窄屏降级方式

## compare-detail-page

信号：

- 左右并列的两个面板
- 相同或相近的子区块结构
- 重复标签条或实体切换器

需要提取：

- 面板数量
- 对齐一致性检查清单
- 子区块 owner
- 面板内局部数据源

## modal-form

信号：

- 类弹窗的边界容器
- header / body / footer
- confirm / cancel 动作

需要提取：

- 弹窗宽度
- label / content 关系
- 按钮对齐方式
- 必填项视觉契约

## list-table-page

信号：

- 搜索 / 筛选输入
- 表头和重复行
- 工具栏和分页

需要提取：

- filter row
- action row
- table region
- pagination row
- 脱离式浮层交互

## tabbed-report-page

信号：

- 报表 tab 或 report id 切换器
- 文档 / 图片预览区

需要提取：

- tab strip
- 激活 / 未激活样式
- 预览区契约
- 切换行为



