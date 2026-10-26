# AutoBiz 多仓作者源变体

`multirepo-source.json` 是 `autobiz/composition/source.json` 的替代作者声明，不是可直接安装的插件包，也不是第二份同时启用的作者源。它复用 `autobiz/` 的全部模块、固定规则、工作流、知识材料和必要Hook，增加required单目录配置 `secondaryRepository` 与受控工作区ID `secondary`。

使用时复制完整 `resources/native-compositions/autobiz/` 到自己的作者目录，再用本文件替换其中的 `composition/source.json`。先通过原生界面安装并批准 `autobiz-native-rules` 和 `autobiz-native-knowledge`；在目标机器通过创造者 `project_actions` 获取真实目录，然后保存该作者目录并运行 `project_compile`，不能复用其他机器的已编译安装ID锁。通过原项目配置入口填写knowledgeRoot、selectedDeployUnits和secondaryRepository。第二仓必须是真实、洁净、用户授权的独立Git仓库，不向模型传目录路径。

计划中的 `workspaceRef=default` 指当前项目仓库，`secondary` 指已绑定第二仓。增加第三仓时需作者显式增加required directory配置和executionResources.workspaces声明，再重新编译、安装和确认配置；不能靠workflow args临时授予路径。

当前工作流按批次DAG串行执行，同仓复用一份原生工作树，跨仓依赖只表示顺序。每仓独立封存、人工批准合并，并在该仓真实integrationCommit运行最终编译与E2E。一个仓拒绝或unknown不会把其他已完成提交自动回滚；整个Code不得宣称成功。未实现并行合并列车、跨仓原子事务、跨仓任意文件读取、frontend路线或远程依赖发布。

真实双仓验证见 `src/main/plugins/autobiz-native-multirepo.integration.test.ts`：实际Git仓、实际Maven编译与Java行为测试、原PlatformHub回执、独立promotion审批、每仓HEAD核验及journal无重派。模型作者与批准回调是确定性夹具。
