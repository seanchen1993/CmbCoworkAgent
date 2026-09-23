# 文件 SDK 的链接与解析路径

参考固定官方 Claude Code v2.1.278 的 FsEntry、FsStat、FsStatOptions 和 fs.stat 事件。接口仍为 partial/bounded。

```ts
const link = await $.fs.stat("src-link", { resolve: true })
const entries = await $.fs.list()
```

- `stat` 的 `isLink` 描述输入路径的最后一项；仅父目录是 junction 时，普通文件仍为 false。`kind/size/mtimeMs` 描述目标。
- `resolve` 缺省 false；设为 true 才附带 `realPath`。Hook 收到规范化绝对 path 与 resolve 布尔值，改写后的路径仍走原权限和项目边界。无效 options 返回 `MODS_FS_OPTIONS`。
- `list` 对每个可见条目执行 lstat，返回 `name/kind/size/isLink`；链接是 other，不跟随它读取外部目标。最多访问 1024 项，原目录/文件权限过滤仍生效。
- stat 在返回前再次确认路径、输入节点、目标设备/inode/类型/大小/mtime/ctime；发布等待期间替换或修改使结果失败。取消、撤权和运行时失效仍中止原调用。

旧插件 Hook 可以省略新增字段；字段存在但类型不对会被拒绝。`$.fs.stat(path, undefined)` 与缺省参数相同。宿主 revision 更新到 `desktop-file-metadata-v57`，插件按新摘要重新授权。

`realPath` 只是这次观测的位置，不锁定以后打开的文件。插件也可改写自己的元数据结果，因此它不能充当宿主工具授权、测试 PASS 或 checkpoint 证据；后续工具继续独立执行原权限检查。

与上游的明确差异：仍只允许项目内访问，dangling link 的 stat 仍拒绝；没有上游全部主机文件访问或完整 errno 等价。512KiB 文本读取上限保留，bytes、fs.write、fs.ancestors 本次未开放。不能由本能力推导为完整文件 SDK 兼容。
