# Python doctest 执行与证据提供器

这是独立 Function Mod，不依赖 AutoBiz delivery Mod 的安装或运行时代码。它实现执行与证据完整单元，适用于 `src/**/*.py` 生产模块、`tests/**/*.doctest` 独立测试及静态项目资源。需本机已有 Python 3、Node 和 Git，无需 pip 或第三方测试库。

## 接线

1. 安装本目录，使用其真实安装 id、插件名 `python-doctest-evidence` 和当前 digest。
2. 在项目源声明中选择本提供器的 `code.verify`、`delivery.verify`；由组合编译器生成真实绑定。保留 `bindProviderIdentity`、规则提供器的 `bindCheckProviderIdentities.rulesProvider` 和脚本资源的 `bindResourceDigests.workflowSha256`。
3. 项目配置 `executionAdapter` 使用 `python-doctest/v1`。默认 AutoBiz 示例的配置 enum 只列 Node/Java，替换提供器的项目需相应修改该声明；不修改通用工作流。
4. 保留项目的 artifactRoles、request provenance 和独立业务检查。代码阶段从锁定的 `code.evidence` 绑定取得提供器身份，从 manifest/roles 取得输入产物路径，再运行原 `lean-code.workflow.js`。

`test.contract` 返回 `devclaw.execution-evidence/v1`、动作集合及编译/测试输入 schema。实现作者返回 `compileArgv: ["python", "-m", "py_compile", "src/orders.py"]`；提供器从 Git 枚举全部生产模块，真正调用标准库 `py_compile.compile`，输出全部源码路径及字节摘要。字节码只写临时目录，不污染工作区。独立测试作者返回：

```json
{"testInput":{"files":["tests/orders.doctest"],"subjects":["src/orders.py"],"timeoutMs":10000}}
```

示例测试内容：

```text
>>> from orders import lookup
>>> lookup("42")
{'id': '42'}
>>> lookup("missing") is None
True
```

`subjects` 必须按字典序列出全部生产 Python 模块。固定报告器读取并运行真实 doctest examples，统计 attempted/failed，拒绝无例子文件和 SKIP；测试 stdout 不充当报告。执行前后核对测试/生产字节与文件身份；每批和最终 E2E 还要与原回执中最近的编译摘要一致。

`code.verify` 实际读取平台原工作流和动作回执，验证脚本、两类提供器身份、产物摘要、动作覆盖、Git 所有权/人工合并/封存/预算及测试计数。`delivery.verify` 继续核对真实输入归档和原 code run。业务交付模板属于独立规则提供器。自动修复仅保留受限 source_bug；不自动弱化断言。

## 验证与边界

- `src/main/plugins/python-doctest-evidence.test.ts`：真实 Python 进程的通过、错误预期、空例子、SKIP、伪输出、额外模块编译失败、测试修改源码及实际 Function 作者类型检查。
- `src/main/plugins/python-doctest-evidence.integration.test.ts`：替换完整执行提供器后运行同一工作流、Git 分工、批次测试、最终 E2E 和实际 `code.verify`，仅模型写文件和用户批准由确定性 fixture 代替。
- 实际 Function 作者预检通过：严格 TypeScript 与 SDK 静态分析均无诊断；SDK helper 采用包内可追踪直调用，不向返回闭包转交 SDK。静态兼容与上面的真实运行验证是不同证据。
- 真实计数和字节摘要证明实际执行及输入一致性，不能证明任意业务要求已被测试语义完整覆盖。固定负例也不是任意语言、框架或恶意测试程序的通用正确性证明。
