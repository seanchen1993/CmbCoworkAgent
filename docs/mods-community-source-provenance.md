# 社区示例来源与验证范围

本文供源码维护、兼容适配与许可证核查使用。原始第三方源码、许可和版权声明仍随相应资源保留，产品名称调整不改变其来源。

## 固定来源

社区包回归固定使用 [claude-code-playground 的示例源码](https://github.com/anthropics/claude-code-playground/tree/569c5283d9a0a7ee7938df85bb32e4f48cbb8c86/claude-code/mods)，仓库提交为 `569c5283d9a0a7ee7938df85bb32e4f48cbb8c86`，目录为 `claude-code/mods`，包含 `token-weather`、`blast-radius` 和 `replay-theater`。

源码来源、提交与内容哈希用于复核具体输入，不能用新的版本号或品牌名称替代。第三方许可证和版权声明保留在原资源中，不因本次官方说明整理而删除或改写。

## 验证边界

回归分别检查目录和 ZIP 安装、实际事件与原生工具链。测试中的模型回执和危险命令执行器受控，不表示执行了真实模型服务或破坏性命令。

单个包安装成功、静态检查通过或固定示例通过，不代表任意社区包及任意版本全面兼容。原包与移植副本分别记录来源、检查及实际运行结果。

应用内的使用说明见 [开发参考](sparks/reference.md)。
