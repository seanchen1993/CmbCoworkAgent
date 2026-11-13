# AUTODEV-E2E 端到端测试资产生成参考

## 目标

- 优先复用项目现有的 Playwright 测试结构
- 只补齐执行目标用例所需的最小资产

本文件不定义用例生成、测试执行或结果判定规则。

## 探索与裁定

- 探索使用 DevClaw 内置有头 Chrome Playwright CLI，确认真实页面、可访问名称、locator、鉴权、数据、console 与 network。
- snapshot 临时元素引用只在当前探索会话使用，不写入持久化 spec。
- 裁定在新的浏览器上下文中重放持久化 Playwright spec，浏览器跟随项目 `playwright.config.*`。
- 认证只通过项目约定的程序化 setup 或明确 `storageState` 建立，不继承探索 cookie、localStorage 或页面状态。
- 每次裁定记录入口 URL、auth status、实际 project 名称、Playwright 版本、配置哈希与诊断路径。project 名称与配置哈希是权威环境标识；浏览器文字说明只作非权威注解。

## 输入优先级

1. 产出的结构化 E2E 用例
2. 与该 feature 相关的前端页面、路由、弹窗和组件
3. 与该 feature 相关的 specs 行为契约、Spring Boot controller、DTO、权限规则和 design.md 接口决策
4. 环境说明、测试账号、seed 数据和依赖服务
5. 现有 Playwright 配置、fixture、helper、page object 与 spec

## 复用顺序

1. 现有 `playwright.config.*`
2. 现有 fixture 和 helper
3. 现有 page object
4. 现有测试目录
5. 只有缺失时才新增 feature 级 fixture、page object 或 spec

默认不要重建整套测试工程。

## 资产映射规则

按 `verification.type` 映射每个步骤：

- `ui`
  - 在 spec 中驱动浏览器
  - 把 locator 和常用动作收敛到 page object
- `api`
  - 通过 API fixture / helper 完成 setup、teardown、登录和辅助校验
- `database`
  - 仅在 UI / API 证据不足，或 cleanup 需要直接访问数据库时才补 DB helper

额外规则：

- 核心用户链路仍应优先走浏览器
- API helper 是辅助能力，不默认替代主用户路径
- DB helper 必须保持 feature 级、轻量、职责单一

## 构建流程

### A. 聚类相关用例

按以下维度聚类：

- 入口页面
- 业务模块
- 共用前置条件
- 共用测试数据
- 共用 API / DB 辅助能力

目标：

- 避免重复 locator
- 提升 page object 与 fixture 复用率
- 把紧密相关场景放进同一个 `describe`

### B. 创建或复用 page object

每个主要页面、弹窗、抽屉或列表区，优先抽成 page object，并暴露：

- `goto()` 或等价入口方法
- 稳定 locator
- 常用组合动作
- 少量只读查询方法

不要把大段跨页流程或大量断言塞进 page object。

优先使用：

- `getByRole`
- `getByLabel`
- `getByPlaceholder`
- `getByTestId`
- 稳定 `id`

默认避免：

- 深层 CSS selector
- 易变 class name
- `nth-child`
- 坐标点击

### C. 创建或复用 API fixture

API fixture / helper 适用于：

- 登录与认证初始化
- 创建 seed 数据
- cleanup
- 切换角色
- 补充响应校验

推荐实现：

- Playwright `request.newContext()`
- 复用项目现有认证方案，不要另起一套并行认证逻辑

### D. 只在必要时补 DB helper

有效场景：

- 需求明确要求验证持久化结果
- UI / API 结果不足以证明关键副作用
- cleanup 必须直接访问数据库

DB helper 要求：

- 尽量只读
- 只服务当前 feature
- 不承载业务逻辑

优先复用项目已有的 Prisma、Drizzle、TypeORM、JDBC、SQL 脚本或其他原生接入方式。

### E. 生成 spec

每个 spec 应映射一条业务用例，或一组紧密相关的用例。

spec 应包含：

- `test.describe`
- 共享 setup
- 与用例步骤对应的 Playwright 操作
- 关键断言
- 必要时调用 API fixture 或 DB helper
- 与场景 ID 或验收标准的映射注释或命名
- 精确的 caseId 绑定：测试标题包含 `[E2E-<feature>-NNN]`，或 spec tag 使用完整 `@E2E-<feature>-NNN`

尽量把 selector 放进 page object，把 setup / cleanup 放进 fixture。

### F. 应用稳定性默认项

执行前补齐项目已支持的最小稳定性能力：

- `storageState` 或等价登录态缓存
- 基于真实页面状态的导航和可见性等待
- 创建数据后的 cleanup
- 已有能力范围内的 screenshot、trace 或 report 支持
- 复用项目既有 retry / timeout；flaky 进入诊断，不为变绿增加 retry、timeout 或固定 sleep

不要把 `waitForTimeout()` 当作主要同步手段。

## Spring Boot + Web 专项检查

为这类项目生成资产时，必须额外检查：

- Spring Security 认证流程
- JWT、session cookie、CSRF 处理方式
- 前端与 `/api` 是否跨域
- `application-local.yml`、`application-test.yml` 或等价测试环境配置
- 测试用户、组织、租户、角色初始化
- 统一错误响应结构
- 异步任务、消息队列、最终一致性行为

如果系统是最终一致性：

- 先断言即时且稳定的成功信号
- 再轮询 UI 或 API 状态
- 除非项目已有明确要求，否则不要默认写固定 sleep

## 输出检查清单

生成后的资产应满足：

- 能直接接入项目现有 E2E 执行命令
- 范围最小且与当前 feature 直接相关
- config、fixture/helper、page object、spec 分层清晰
- 能追溯到场景 ID 或验收标准
- caseId 可从 Playwright JSON report 的精确 tag 或固定标题标记定位
- 失败时可诊断
