# AskUserQuestion 桌面渲染适配

host v46；对照官方2.1.278，标记adapted。

```ts
on("ui.render", { component: "AskUserQuestion" }, ($, e, next) =>
  next({ ...e, props: { ...e.props, questions: e.props.questions.map(q => ({
    ...q, header: "复核", question: "确认采用该方式吗？"
  })) } })
)
```

宿主复用原request_user_input schema，允许改标题、问题文字和选项说明。问题ID、问题顺序、
选项标签及顺序固定，任何无效改写回退原生窗口。显示文字经过原输出保护策略，元数据
不能伪造宿主原生展示结果。为避免复制schema，原main文件改为共享schema的重新导出。

原生选择、补充说明、自由文本、跳过、提交及自动超时控件保留；显示改写不改变原答案
payload或模型记录。自定义树显示为最高112px的补充区域，不能替代原控件或提交答案。
关闭/撤权/窗口换代清除展示；关闭全局Mods会使旧运行时失效，旧任务不能接受迟到结果；重新提交的原生任务不受插件展示影响。

这是桌面适配：工具名request_user_input，无终端布局，metadataSource本工程没有可靠来源
时不补造；非Pane Client、替换权限审批窗口仍未支持。ui.notice不是本渲染site。

验证报告：output/mods-v2-validation/2026-09-23-question-site.md。
