# Autobiz checkpoint 提交的 Windows CAS 边界

本批修复指纹检查与上游 replace 之间的状态竞争，不改变 ModsManager、FunctionSession、authority、completion evidence 和真实 validator 的授权职责。只有这些宿主检查通过后，才调用这里的提交适配器。它不是通用分布式存储，也不把合同 fixture 的通过表述为最终业务验收。

## 正常提交

1. 使用应用既有 `getCmbCoworkAgentDataRoot()` 下的 `mods/autobiz-commits/journal.sqlite`。SQLite 使用 `synchronous=EXTRA`、DELETE journal；插件不能传入该路径。应用数据根位于工作区内或包含 junction 时拒绝。工作区旧 `.mods-v2-transition-*.json` 完全不再作为凭据。
2. Python 子进程从宿主 Git archive 提取的固定版本 `8db1ec937d6ed3d271cb9dc540310d6633c91e70` 导入真正的 prepare、workflow contracts、validator、serializer 和 state writer。工作副本的源码修改不影响此 pin。
3. 只支持 Windows 本地固定 NTFS 卷，拒绝 UNC、其他卷类型、reparse 路径、硬链接状态文件。对路径每级目录保持禁止 DELETE 的句柄；对现存 `state.json`、`STATE.md` 使用 `CreateFileW(GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ)`。已打开的 writer 或 writable mapping 会使获取失败，之后的新 writer、删除和 rename 也会被拒绝。宿主仍能只读采集证据。
4. 在相同文件句柄保持打开期间读取、核对原始字节哈希和文件身份。上游 `prepare_checkpoint_update` 内部原本调用 `fix=True`，宿主适配器将它限定为真实同步检查函数的 `fix=False`；准备阶段不修复现场。
5. 真正的上游 writer 只写私有临时快照，复制有界 workflow overlay。输出必须与真实 prepare 产生的 JSON 和 Markdown 一致，包括 Windows 上游文本写入的换行转换。每份状态最大 256 KiB；超限拒绝。
6. 子进程发出带 operation ID 和前后文件内容/哈希/身份的 ready。宿主重新验证 completion evidence，并把意图持久化为 pending，然后才发送一次 commit ACK。
7. 子进程通过原始句柄有界写入、截断、`FlushFileBuffers` 和读回复核两个文件，再运行上游只读同步检查。它继续持锁并等待宿主将意图记为 committed；收到 release 后关闭句柄。操作日志保留两份文件的前后字节证据和 pin/Feature/状态变更身份。

宿主 operation ID 绑定 canonical workspace 和 idempotency key；数据库身份同时绑定 Feature、from、to 和源码 pin。重复结果必须有宿主 committed 记录，且两份文件当前哈希与文件身份都相同。`actual == to` 本身不是幂等证明。未归属的已推进状态返回 `AUTOBIZ_CHECKPOINT_UNATTRIBUTED`。

宿主 completion ledger 的重复事件分支必须传 `requireCommittedReceipt: true`。缺少可信 committed 记录时返回 `AUTOBIZ_RECEIPT_REQUIRED`，不启动准备子进程、不推进状态；不会先应用后再因“不是 duplicate”而报错。unknown 阻断新 key 时，返回的 operation ID 指向原未知提交，便于定位原始证据。

## 失败和重启

ACK 前的取消、撤权或证据失效不写入状态，也不创建 pending 意图。ACK 后的进程退出、超时、撤权、协议失败或写入失败返回 `status: unknown`、`applied: false`、`duplicate: false`，并保留意图证据。重开宿主数据库时，同一 workspace 的 pending/unknown 会阻止任何新 key 推进，返回原 operation ID；不会自动回滚现场，也不会因 JSON 已等于目标而补报成功。

已经写入 JSON、尚未写 Markdown，以及两份文件均已写入但宿主结果被取消，都有真实子进程回归测试。这里的“重启”回归验证数据库关闭后重新打开与新子进程，不替代整套 Electron 重启 E2E。

本批不实现部分提交的自动恢复。即使现场恰好匹配预期 before/after，也保持 unknown，等待独立恢复流程。后续若实现恢复，需要新的授权、重新运行真实 validator、重新核对需求/文件证据，并只对严格匹配的现场修复投影或收据。不能删除 unknown 日志后盲目重试。

## 明确未保证的范围

- 两份文件不是物理原子事务。进程死亡或断电可能留下部分内容；正确结果是 unknown/blocked。未使用 TxF。
- 为允许宿主证据读取保留 FILE_SHARE_READ；其他 reader 可能在原位写入期间看到中间状态，因此不宣称读者原子可见。
- 状态句柄不冻结整个 workspace。需求、代码、测试报告、workflow overlay、新增文件仍由 completion evidence 的前后校验负责，存在最后检查后的外部变化窗口；本适配器没有把整个项目变成事务快照。
- 保护范围是普通 Win32 文件访问和路径操作。具有管理员/内核权限、原始磁盘访问或可以修改宿主应用数据的进程不属于插件隔离边界。
- 不支持网络卷、非 NTFS、reparse 目录/文件和状态硬链接；拒绝推进而非降级为不安全 replace。未在非 Windows 平台实施等价事务后端。
- 本批未增加自动修复 unknown 的 UI。宿主必须显示阻断原因和 operation ID，不能把 unknown 重试当作 PASS。

## 测试证据

`src/main/mods/v2/autobiz-state-commit.test.ts` 首次五项全部失败，日志为 `output/mods-v2-validation/2026-09-23-autobiz-cas-red.log`。覆盖伪收据、新旧 writer、rename、同目标假 duplicate、Markdown 竞争，随后扩展真实 writable mmap、并发请求、junction、ACK 前取消、ACK 后退出/部分写入/超时、写完后撤权、重新打开持久日志。

`autobiz-validation.test.ts` 和 `autobiz-completion.integration.test.ts` 继续使用真正的固定版本 compiler/validator、真实 QuickJS guest/session 和临时项目测试 runner；包含关闭/开启对照、缺失产物、失败修复后复检和动态 workflow。它们是合同与生产链路验证，不能代替真实业务示例验收。

Win32 行为依据：[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)、[目录句柄](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)。现有 writer、writable mapping 和目录 rename 限制在本机 NTFS 临时 fixture 上实测。
