# E2E 质量门禁参考

## 机械扫描分级

`blocker`：

- locator 对象的 truthy / defined / null 恒真断言
- Playwright 断言或动作缺少 `await`
- 丢弃 `isVisible`、`isEnabled` 等状态读取结果
- 条件分支内断言
- `test.only`、`it.only`、`describe.only`
- 空 `catch`、立即 `return` 的 `catch`、空 Promise catch
- 测试体内零断言
- `test.fail()` 预期失败声明

`major` 与 `minor` 记录非阻断质量问题。发现等级只使用 `blocker`、`major`、`minor`。

## 裁定

机械命中初始为 `candidate`。逐条写入：

- `confirmed`：真实问题，修复后重新扫描。
- `dismissed`：误报，填写 reviewer 与非空 rationale。

任一 `candidate blocker`、`confirmed blocker` 或未解析 import 都阻断 verdict。扫描输入变化后重新扫描；对应文件变化的历史裁定回到 `candidate`。

## 语义审查

按 refute-first 顺序检查：

1. 测试名称与断言目标一致。
2. 用户动作后存在可观察的 Then。
3. 受保护路由有程序化认证准备或明确 `storageState`。
4. 乐观 UI 写操作有请求完成或持久结果证据。
5. fixture 数据不会被组件渲染 guard 静默过滤。
6. PRD 每个外部接口 `SRC-NNN` 都在用例 `source.external_sources` 中出现，并已打开原始资料。
7. 测试实际请求的 method/path、鉴权、请求/响应断言、错误和超时处理与 `SRC-NNN` 原契约一致。
8. 有副作用调用只指向测试/沙箱环境；生产只读验证必须有明确授权和无副作用证据。
9. reviewer 的 External Interface Coverage / E2E Focus 中每个外部接口风险都有用例或明确 BLOCKED/missing 结论。

新发现以 `semantic:<name>` 规则登记为 `confirmed`，并把实际读过的产品源文件加入扫描输入。

## 修复边界

- 机械问题只改当前 feature 的 spec、fixture、Page Object、helper、mock、测试数据辅助或 E2E 配置。
- 语义问题先区分测试资产、生产源码与契约缺口，再进入对应失败分类。
- 不通过 retry、扩大 timeout 或固定 sleep 消除 flaky。
