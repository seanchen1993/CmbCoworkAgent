# 公开 JSX factory：h 与 Fragment

Function Mods 的 hooks 和 Client VM 现在都可调用全局 h / Fragment。固定官方参考为Claude Code v2.1.278声明（文件头2.1.277）；当前实现为partial/bounded，不能据全局名称存在推导完整环境兼容。

```ts
on("ui.render", { component: "Pane" }, ($, e) => {
  const { Text, Button } = $.ui.resolve(e)
  return h(Fragment, null,
    h(Text, null, "当前结果"),
    h(Button, { key: "run", label: "执行", onPress: () => {} }))
})
```

公共h与编译器原有私有factory共享实现。安装时扫描器识别直接 h(Client, {...})、解构重命名的 Client 和原 JSX 编译形式，将模块纳入批准摘要；修改模块会改变摘要，动态或越界路径仍拒绝。不承诺任意 factory 间接别名或 globalThis.h 形式的静态模块发现。h只接受组件/构造器函数，手写string tag仍拒绝MODS_UI_TAG；不增加任意HTML、DOM、Node或host权限。组件返回null/undefined可以在children中省略，显式子参数优先于props.children；数字转换为文本，布尔/null/undefined不绘制。原树验证、回调owner/generation、深度和节点预算保留。

Fragment产生flexDirection:column的Box；既适用于手写h(Fragment, ...)，也适用于Function Mods源码中的<>...</>。此前私有Fragment的Box没有指定方向，实际呈横向；现按固定声明修正。需要横向布局的插件应明确使用Box的flexDirection:"row"。应用自身React Fragment和存量业务组件不受影响。

绑定采用不可配置且无setter的getter，公共和私有别名不能赋值、删除或通过Object.defineProperty替换。实际VM测试发现当前QuickJS的全局data descriptor虽然显示writable:false/configurable:false，仍允许改value；不能只凭descriptor宣称只读。此实现没有修改共享依赖，也未泛化为全部guest globals的兼容或不可变性声明。

关闭/撤权后原面板和回调由原生命周期移除。Client state仅属于当前活跃实例，renderer重载与父改绘可保留，session重建不承诺恢复。此次纯factory公开及布局修正不扩大宿主授权能力，host revision仍v62。
