# 文件读取模式

宿主修订v65将默认 `$.fs.read(path)` 和显式 `$.fs.read(path, {as: "text"})` 都转换为 `{path, as: "text"}` 操作。显式省略可选参数（`$.fs.read(path, undefined)`）在guest发送前移除该参数，避免JSON桥把undefined变成null；显式null仍拒绝。插件可观察和改写路径，最终读取仍受原项目权限、稳定文件句柄、512 KiB上限与强制发布过滤约束。旧 Hook 返回 `{path}` 仍按文本读取。

```ts
const text = await $.fs.read("README.md", {as: "text"})
```

SDK第二参数必须是只包含可选as字段的对象；null、数组、未知字段、非法模式或多余参数返回 `MODS_FS_OPTIONS`。`as: "bytes"` 返回 `MODS_FS_BYTES_UNSUPPORTED`，包括 Hook 的next改写。以前这些参数被忽略，可能让调用方误把文本当成字节；现在明确拒绝，不会先读取文件再决定格式。

当前只支持文本，未实现官方声明的 `{base64}` 字节结果。二进制读取还需要与强制发布过滤一致的契约，不能先Base64编码绕过文本检查，也不能将有损UTF-8文本重新编码当真实字节。矩阵两行继续partial/bounded。原生Agent的read_file行为不变，关闭Mods仍使用原生路径。

官方参考：[Claude Code v2.1.280声明](https://github.com/anthropics/claude-code/blob/v2.1.280/mods/types/claude-code.d.ts)。验证见[日期报告](../output/mods-v2-validation/2026-09-24-file-read-options.md)。
