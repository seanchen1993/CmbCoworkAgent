# 文件写入 SDK：原生审批与真实租约

`await $.fs.write(path, text)` 已接入真实 FunctionSession 和原生 `write_file`。与固定官方 v2.1.278 的位置参数、`fs.write` 事件 `{path,text}`、void 返回对应；仍为 **partial / bounded**，不能声明全部文件 SDK 兼容。

在已授权插件中，从用户提交的非 immediate 命令调用：

```ts
on("command.run", { command: "save-note" }, async ($) => {
  await $.fs.write("notes/result.md", "Reviewed draft")
  return { text: "写入完成" }
})
```

路径相对当前执行目录解析。fs.write hook 可以改写路径/文本或 deny；最终路径仍走原生 ModsManager、runtime/授权、审批、LocalSandbox 和 durable receipt。没有直接的插件文件写权限，也不会为这一次 SDK 调用再派发一轮 Function tool.call 检查；原生工具的原有检查照常执行。

## 权限和执行边界

- 自动模型 hook、immediate 命令和未持有租约的 UI 回调不能写文件。宿主入口绑定真实租约实例；释放、交接及同 ID/时间戳重新获取都不能恢复旧调用的权限，嵌套回调也不能刷新旧实例；另一 thread/workspace 或已结束作用域的延迟回调不能继承该写入权限。
- 等待审批之后、原生执行和发布边界继续复核。撤权、取消或 runtime 替换不接受旧结果。落盘之后权限才失效时，只能报告中断事实；不能承诺回滚已经发生的写入。
- 保留现有原生工具 JSON 参数 16000 字符预算，小于官方读写 4 MiB 上限。原生写入失败返回错误，不会丢弃 isError 并当作 void 成功。
- 原 dispatcher 的可选 hook 错误处理不变；非法替换结果会跳过该 hook，合法 deny（包括空字符串）阻断。hook 可短路返回 void，但这不构成宿主执行回执，更不是测试或业务验收 PASS。
- host revision 升为 `desktop-native-file-write-v58`，旧授权不能自动获得新能力。

## 验证范围

先增加失败测试，覆盖 guest 参数/改写/空 deny/原生错误，以及释放物理租约仍写入和同 ID/时间戳重取租约两个实际缺陷。实际 guest/session/LocalSandbox 测试检查磁盘与原工具回执，审批期故障必须同时满足无文件、无成功回执。Electron 验证真实命令、最终审批参数、拒绝/只读/自动 hook/撤权和关闭后原生读取。

详细运行结果见[本次报告](../output/mods-v2-validation/2026-09-24-file-write.md)。这套契约验证不作为业务最终验收。
