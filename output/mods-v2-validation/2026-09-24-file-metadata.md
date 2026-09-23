# 文件 SDK 元数据验证 — 2026-09-24

基线 `f06fead5`；仅 Mods v2 工作树。官方固定参考 v2.1.278，补 fs.stat 的 resolve 参数、stat/list 的 isLink 和受限 canonical realPath，保持原权限/发布过滤/项目边界。host revision 更新为 desktop-file-metadata-v57。未扩大 fs.write/ancestors/bytes，矩阵仍 partial/bounded。

## 失败先行与实现

- 初始 `file-metadata.test.ts` **5 项全部失败**：options 丢失、isLink/realPath 缺失、list 缺字段、发布期间目标替换仍返回旧值、无效新增字段被接受。日志 `2026-09-24-file-metadata-red.log`。
- 真实 FunctionModsManager/QuickJS/FunctionSession/项目文件系统测试先失败，缺少 isLink 和 canonical realPath。日志 `2026-09-24-file-metadata-session-red.log`。
- 普通 Electron 构建先失败，真实 junction stat 的 isLink 是 undefined。日志 `2026-09-24-file-metadata-electron-red.log`，未修改测试去接受缺失结果。
- stat SDK 把 options.resolve 转为事件 resolve 字段，默认 false；原路径规范化和 hook 改写链保留。显式 undefined 选项在 QuickJS JSON 跨境前归一为缺省；null/错误类型/未知 options 被拒绝。
- native stat 返回目标 kind/size/mtimeMs、输入最后一项的 isLink；仅 resolve=true 返回 canonical realPath。输入节点及目标的 dev/ino/mode/size/mtimeNs/ctimeNs 在发布等待后复核，替换/修改保守失败。异步检查后再次复核取消/授权。
- native list 对当前条目 lstat，不跟随外部 junction 读取目标，保留 1024 项访问上限和原权限过滤。普通目录/file 也有 isLink:false。
- 结果校验容许旧 hook 省略新增字段，保留原插件替代结果形状；新增字段存在则校验类型。canonical metadata 不是工具授权或 PASS 证据。

## 当前验证

- 首轮 5 文件89测试通过；后续追加取消/撤权及最终检视后，4文件44测试通过，另前述manager整文件47通过。真实 utility process/session **41 checks PASS**，exit0。
- Electron focused **5 checks PASS**：真实元数据与 hook 路径改写、项目外 junction 拒绝、撤权阻止迟到结果、关闭模块后原生Agent/read照常工作。元数据操作本身没有模型请求，关闭对照使用本地 HTTP fixture；不是外部业务验收。截图已实际检视。
- Node / Web / helper 类型检查通过。Node 首次仅新测试数组 union 推导出 undefined 的类型失败，已明确为 ModJson[]，重跑通过。
- ESLint 新 metadata/test/helper 无警告。比对 HEAD 后，旧 basic-sdk 2 与 manager.test 116 警告均原样保留；曾出现 basic-sdk 混合 CRLF/LF 导致额外277警告，已统一 LF，最终没有新增 warning。完整基线对比 `2026-09-24-file-metadata-lint-baseline.json`。
- 整套 Mods45 **136 files / 1205 PASS**，exit0 已确认。完整 Electron **186 checks PASS**，exec62539 exit0 已确认，普通 out 已恢复。独占标准性能 smoke 已完成，exec27120 exit0。

- 独占性能 smoke：`desktop-performance-2026-09-23T23-29-54-616Z-smoke-78e4e86f/`，qualified=false / passed=false。off/on 各2样本 TTFT p95 为127.4/183.3ms，增量55.9ms；吞吐比0.998273，约1秒 idle CPU 增量1.577565单核百分点。小样本不能替代正式门槛，也不支持统计意义上的改善声明。
- 最终代码检视检查了原文件权限、发布复核、取消/撤权、旧 hook 结果兼容和参数跨 QuickJS JSON 边界；git diff --check 通过。未更改原生工具读写权限。

## 差异与风险

读取仍项目内、512KiB文本；stat dangling link 仍按缺失拒绝，不是上游全部 errno/主机文件系统语义。目录列表不是整个工作区原子快照，stat 只确认这次观测，不能锁定以后访问。新增 inode/metadata 复核可能拒绝并发修改中的路径，这是保守失效，不返回旧成功。

此前正式 TTFT +67.7ms、ingress关闭对照1/10超预算仍未过；2h10000 soak及Actions安装交付待完成。本次没有修改UAT/共享依赖或本机NSIS打包。
