# Ant Design 转换参考

本参考供 `standard-html-parser.md` 在决定生成 Ant Design 代码时读取。只支持 Ant Design v4 和 v5。转换时按语义意图判断，不按标签名机械替换；先保留源行为，再选择能表达该行为的最小 Ant Design 组件。

## 内容目录

- 版本门槛
- Ant Design 映射矩阵
- 数据模型
- 通用规则
- 常见组件映射
- 覆盖审计
- Provider
- 验证清单

## 1. 版本门槛

- 从 `package.json`、lockfile、imports 和现有源码中检测 Ant Design major 版本。
- v4 项目保留 v4 约定：`antd/dist/antd.css`、Less 变量主题、overlay 的 `visible` props、静态 feedback API 等本地既有模式。
- v5 项目保留 v5 约定：`antd/dist/reset.css`、`ConfigProvider` theme tokens、CSS-in-JS、`App` provider、overlay 的 `open` props、`items` 数据驱动 API。
- 不生成 v4/v5 以外版本的 API。
- 项目已有 Ant Design wrapper 时使用 wrapper，不直接导入裸组件。
- `@ant-design/icons` 版本和使用方式要匹配项目已有约定。

## 2. Ant Design 映射矩阵

当 Ant Design 适用或可能适用时，编码前先建立映射矩阵。小页面可以很短，复杂后台 / 产品 UI 必须覆盖全部候选控件和数据面。

| 源 HTML | 意图 | Ant Design 组件 | 转换? | 原因 |
| --- | --- | --- | --- | --- |
| `<button class="primary">` | 主操作 | `Button type="primary"` | yes | 行为型控件 |
| `<table>` | 记录表格 | `Table` | yes | 结构化行列数据 |
| `<select>` | 单选选择 | `Select` | yes | 产品表单控件 |
| 品牌视觉容器 | 自定义视觉布局 | 原生 React / CSS | no | 保真优先 |

把矩阵作为编码清单使用。每个产品 UI 控件、数据面、导航模式、反馈元素、overlay、表单控件候选，都要进入矩阵并给出 convert / keep 决策。

## 3. 数据模型

写 JSX 前先抽取结构化数据：

- `options`：用于 `Select`、`Radio.Group`、`Checkbox.Group`、`Segmented`、`AutoComplete`、`Cascader` 等简单选项。
- `items`：用于 `Menu`、`Tabs`、`Breadcrumb`、`Steps`、`Dropdown` 等。
- `columns`：用于 `Table`。
- `dataSource`：用于 `Table`、列表和仪表盘数据。
- `treeData`：用于 `Tree`、`TreeSelect`、层级菜单和嵌套选择器。
- `initialValues`：用于 `Form` 默认值。

稳定 key 优先来自源 id、`name`、`value`、`href`、`data-*`、业务行 id、标签 slug；数组 index 只能最后兜底。

## 4. 通用规则

- 优先遵循项目现有 imports、文件位置、样式、wrapper 和版本 API。
- 文章、装饰、营销视觉、插画和高度自定义布局保留 native/custom React markup。
- 产品 UI 使用 Ant Design：表单、表格、筛选、CRUD 操作、导航、仪表盘、弹窗、反馈、上传、选择和记录视图。
- 保留源 id、label、选中态、禁用态、loading、校验提示、空态、错误态、键盘语义和 ARIA 意图。
- TypeScript 中数据类型明显时不要使用 `any`。
- 不要把每个区域都包成 `Card`，不要用 `Space` 或 `Layout` 解决所有布局问题。

## 5. 常见组件映射

### Button / Icon

- action button 和 action link 转 `Button`。
- 保留 `htmlType`、`danger`、`disabled`、`loading`、`href`、`target`。
- 只有局部主操作使用 `type="primary"`。
- 图标仅在项目图标体系或 Ant Design icons 能匹配时替换；品牌或特殊 SVG 保留原资产。

### Layout / Grid / Space / Divider

- 真实 app shell 才转 `Layout.Header` / `Layout.Sider` / `Layout.Content`。
- 表单 / 仪表盘网格可用 `Row` / `Col`；自定义响应式组合优先 CSS grid/flex。
- `Flex` 为 v5 组件；v4 使用 CSS flex 或项目 helper。
- `Space` 只用于小范围按钮组、工具栏簇、inline actions。
- `Divider` 只用于内容组分隔，不用于纯装饰线。

### Typography

- 产品文本且项目使用 Ant Design Typography 时，可转 `Typography.Title` / `Text` / `Paragraph` / `Link`。
- 编辑性、营销性和强品牌字体保留语义标签与自定义样式。

### Menu

- 侧栏、顶部导航、命令导航转 `Menu`。
- v5 和较新 v4 优先 `items`；老 v4 或本地惯例可用 children API。
- key 来自 route path、href、id 或稳定源值。
- 保留 `selectedKeys`、`openKeys`、`mode`。
- 不要把路由导航转成 `Tabs`。

### Tabs

- tablist/tab-panel、同页切换面板转 `Tabs`。
- key 来自 panel id、`href="#panel-id"`、`data-*` 或 active value。
- 静态初始态用 `defaultActiveKey`；动态才用 controlled `activeKey`。
- 不要把 breadcrumbs、顶级路由、侧边菜单或外链转成 `Tabs`。

### Form / Input / Select / Upload

- 真实表单转 `Form` 和 `Form.Item`。
- HTML validation 属性转 `rules`：`required`、`minLength`、`maxLength`、`pattern`、email、url、numeric range。
- 默认值放 `initialValues`，不要同时给 Form 子控件重复 `defaultValue`。
- `Checkbox` / `Switch` 用 `valuePropName="checked"`。
- 文本、密码、搜索、textarea 转 `Input` 系列。
- 数字输入转 `InputNumber`，保留 min/max/step/precision。
- 简单下拉转 `Select options`，保留 disabled、多选、allowClear、showSearch、默认值。
- 文件输入和 dropzone 转 `Upload`，保留 `multiple`、`accept`、preview/list 语义；纯本地选择用 `beforeUpload={() => false}` 或项目惯例。

### Date / Time / Slider / Rate

- 日期时间输入转 `DatePicker` / `TimePicker` / RangePicker。
- v4 通常 Moment，v5 通常 Dayjs，除非项目另有约定。
- range input 转 `Slider`。
- rating 转 `Rate`。
- `ColorPicker` 为 v5 组件；v4 保留 native/custom。

### Table / List / Card / Descriptions / Statistic

- 记录型语义表格转 `Table`，抽取 row type、`columns`、`dataSource`、稳定 `rowKey`。
- 简单内容表 / 对比表可保留语义 HTML。
- action cell 转 `Button`、`Dropdown`、`Popconfirm` 或 link。
- 移动端风险列要设置 `scroll={{ x: ... }}` 或响应式处理。
- 重复简单记录可用 `List`；列式数据优先 `Table`。
- 详情键值对转 `Descriptions`。
- 关键指标转 `Statistic`。
- `Card` 只用于有独立 title/actions/cover/extra 或重复内容单元的块，避免嵌套卡片。

### Tag / Badge / Avatar / Image / Empty

- 状态、分类、标签转 `Tag`。
- 数量、在线点、状态点转 `Badge`。
- 用户或实体图片 / 首字母转 `Avatar`。
- 预览图库转 `Image.PreviewGroup`；装饰图保留 `img`。
- 明确无数据状态转 `Empty`。

### Collapse / Timeline / Tree / Calendar

- Accordion 转 `Collapse`。
- 时间事件列表转 `Timeline`。
- 层级可展开结构转 `Tree`。
- 月 / 日期网格或日程视图转 `Calendar`。

### Overlay / Feedback

- 阻塞对话框转 `Modal`。
- 侧边编辑 / 详情面板转 `Drawer`。
- 危险或不确定 inline 操作转 `Popconfirm`。
- v5 使用 `open`，v4 按项目约定使用 `visible`。
- 持久提示转 `Alert`。
- 瞬时反馈转 `message` 或 `notification`；v5 场景注意 `App.useApp()` 或 provider context。
- loading 转 `Spin`，骨架转 `Skeleton`，进度转 `Progress`。
- 整页成功 / 错误 / 空结果转 `Result`。

## 6. 覆盖审计

当 Ant Design 被请求、被选择，或被后台 / 产品 UI 强烈暗示时，实现后必须审计 JSX / TSX 源码。不要审计运行时 DOM，因为 Ant Design 组件自身会渲染原生 `button`、`input`、`table` 等节点。

从 `autodev-code` 技能根目录运行：

```bash
python -X utf8 references/frontend-html/with-standard-html/scripts/audit_antd_coverage.py <target-react-project-or-src> --format markdown
```

退出码 `0` 表示未发现候选项；退出码 `1` 表示发现可能遗漏的转换候选项，应把输出作为待处理清单继续处理，不视为脚本故障。

重点检查源码中残留的原生产品 UI 候选：`button`、`input`、`textarea`、`select`、`option`、`form`、`table`、`thead`、`tbody`、`tr`、`td`、`dialog`、`details`、`summary`、`progress`、`meter`、tablist、modal、alert、pagination、upload、menu、filter、validation hint。

每个剩余候选必须转换成合适的项目组件 / Ant Design 组件，或说明保留 native/custom 的原因。保留原生实现时，在附近添加 `antd-audit-ignore` 注释并写明原因。

## 7. Provider

- 只有主题、locale、组件配置、prefix、direction 或项目既有根配置需要时才添加 `ConfigProvider`。
- v5 中使用 contextual feedback API 时添加 Ant Design `App` provider。
- provider 放在项目根或既有 wrapper，不要在叶子组件重复包。

## 8. 验证清单

- build 通过，无 unresolved Ant Design imports。
- 样式按安装版本正确加载。
- 无 deprecated props、missing keys、Form child value、overlay prop mismatch、feedback context 等明显 warning。
- Form 默认值、校验、提交、disabled/read-only、upload list 和 checked 值工作。
- Radio、Checkbox、Select、Segmented、Switch、DatePicker、Tabs 状态正确。
- Table 有稳定 `rowKey`，列可读，分页 / 横向滚动合理。
- Menu / Tabs / Breadcrumb 表达正确导航类型。
- Modal / Drawer / Dropdown / Popconfirm 打开关闭正常。
- Loading、empty、error、success 状态明确。
- Ant Design 覆盖审计完成；没有未审计 / 未说明的原生产品控件、表单、表格、弹窗、反馈、分页、上传、导航或数据面残留。
