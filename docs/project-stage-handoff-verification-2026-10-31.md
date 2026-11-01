# 项目模式阶段衔接补验

日期：2026-10-31。验收范围按用户要求限定为阶段衔接，不要求重新执行整套业务实现。结论：四组衔接矩阵通过，代码结束到交付、审计及最终完成的边界已补齐。连同原 Host 服务与已接受输入回归，三个文件共 55 项通过；Node/Web 类型检查、该新增文件 ESLint 通过，独立代码评审通过。

## 验证结果

| 对象 | 已验证的尾部衔接 | 最终状态 |
| --- | --- | --- |
| 当前五阶段 AutoBiz 模板 | code → delivery → completed | completed |
| 当前模板追加 audit 的组合 | code → delivery → audit → completed | completed |
| 此前真实模型保存的六阶段派生源码 | code → delivery → audit → completed | completed |
| 非 AutoBiz 供应商流程 | risk → approval → archive → completed | completed |

当前交付作者源摘要：6e8933e20020dadea4011f62714cb91283c6e180f0409805b1cb0417cbedec5f。此前真实派生源码摘要：9067032b7895e339eca7427855252da1faca861635ce404f7fa52e7ebb37ebe9，执行前按预期摘要严格核对。追加审计组合另外记录声明和编译包摘要，不与五阶段原包混同。

## 什么是真实执行，什么是受控输入

实际执行原生组合编译器、HostProjectService、SQLite 状态存储、包快照、原产物输入绑定、文件摘要检查、成果确认、阶段推进和重开后的状态读取。编译后的输入、上下文与输出声明及 Skill 的 Inputs 内容，与作者声明逐项核对。

测试中的阶段正文执行、业务 action 结果、授权和配置身份使用明确标注的受控输入；没有调用真实模型实现业务，也没有执行 Git 提交、编译、业务测试、远程部署或原生审批弹窗。业务 action 的受控结果只存在于隔离测试替身，生产校验和模板没有被替换。JSON Schema、产物摘要及 Host 状态推进仍走真实实现。

每次推进后重新打开 SQLite，核对阶段位置和项目状态。下一阶段实际读取声明的上游文件，并核对其摘要等于前一阶段已接受的内容。最终状态必须由 Host 推进到 completed，不直接写数据库制造完成状态。

## 防止错误推进

- 受控业务检查失败或尾阶段产物无效时，不能推进。
- 声明需要成果确认时，未确认不能推进；测试通过原接口提供受控确认。
- 结果文件被改动时，真实 Host 必须返回 EVIDENCE_STALE；测试替身不负责抛这个错误。
- 上游已接受产物被替换时，下一阶段不能准备执行。
- 重复推进不重复执行阶段、不增加项目版本。
- 最后阶段完成后，不能再准备新的阶段。

所有场景使用相同测试流程，没有添加 AutoBiz 专属平台分支，也没有改变生产权限、业务门禁或源码。测试未触碰此前真实运行的 failed/unknown 记录或工作树。

## 环境事项单列

此前隔离 Git 身份缺失，以及多次人工审批等待触发原生动作 120 秒总时限，是历史真实业务运行的环境阻塞，不计入本轮衔接失败。本轮也不把这些历史运行改写成业务成功。

因此，“阶段衔接已补验通过”和“完整真实模型业务实现已全部跑通”是两个不同结论；本报告只确认前者。复杂回退、外部副作用补偿、真实知识提供器执行和业务实现质量不在本次补验范围。

## 证据与复现

- 测试：src/main/plugins/project-tail-handoff.integration.test.ts。
- 结果：output/project-tail-handoff-20261031/evidence.json，包含四组逐阶段转移、源码摘要、编译包摘要、受控边界和最终状态。
- 最终日志：%TEMP%/project-tail-handoff-final-20261031.log。
- 类型检查日志：%TEMP%/project-tail-handoff-typecheck-20261031.log。
- D 盘随附同一结果文件：阶段衔接验收.json。

默认回归覆盖当前模板、追加审计和非 AutoBiz 三组。要补验已保存的真实派生源码，显式设置 PROJECT_HANDOFF_DERIVED_SOURCE 与 PROJECT_HANDOFF_DERIVED_DIGEST；PROJECT_HANDOFF_REPORT 指定结果输出文件。测试不会自动查找或修改用户的既有项目。

首轮非 AutoBiz 用例因测试产物生成器遗漏 JSON Schema 的 const 而失败，已修正通用测试生成器，未修改平台或插件 Schema。首次日志与部分结果保留为同目录的 first-run.log、first-run-evidence.json。最终结果以 evidence.json 和最终日志为准。
