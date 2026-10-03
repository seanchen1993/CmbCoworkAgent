# B00 进行中审查

2026-10-04 · 主代理记录；尚未提交候选，不能视为验收

## 实际位置

- 实施树：`/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`，`codex/devclaw-bot-local`，基线`6530c052`。
- 唯一实施者：`/root/b00_local_docker`，gpt-6.1-sol/xhigh。
- 2026-10-03 14:30 UTC附近代码仍未提交：新增`deploy/dev/docker/`与本人attempt。完整镜像／Compose／JDBC尚无候选验收结论。

## E1：必须按结构验证完整VM配置（已下发，待复验）

早期`host.mjs/validateVm`仅用全局正则寻找`enabled:false`、`address:false`等，且只截取mounts之后500字符。其他对象的同名键可掩盖Kubernetes启用，窗口外的额外挂载可能遗漏，不能证明当前profile符合任务要求。

要求：用已有yaml依赖解析完整配置，核对准确键和完整挂载数组、无provision／危险Docker覆盖等；重复键、额外挂载及错误profile拒绝。不要增依赖／改变锁文件，已有节点依赖可本地克隆。必须加入能覆盖散落同名键及超过500字符后新增mount的负例；主代理复验最终候选，不以“已收到”关闭。

进行中复验：草稿已改为完整strict YAML + deep equality；主代理Node22运行 `--test tests/bot/docker/config.spec.mjs` exit0、6/6、skip0。仍需在最终冻结SHA上复跑，不能据此接受完整环境。

## E2：完整容器策略与清理对象（已下发，待复验）

`lifecycle.mjs`早期版本只检查3306绑定、bind源目录前缀及mount数；要求遍历全部实际发布端口（额外exposed但null可保留）、核对精确五个type/source/destination/RW，不允许同目录下替换挂载绕过。cleanupTest必须把entry.dir限定为RUNTIME内对应project的规范目录并要求已认领inode，不能接受缺inode的任意对象。需负例和执行型复验。

## 环境路径副作用（已记录，待最终核验）

Colima0.10.3首次遇到不存在的COLIMA_HOME后，创建了默认`.colima`里的本次profile配置及空稀疏盘。子代理报告停止确切PID49223、检查来源仅含本次新建文件，再用可恢复移动保留到私有`.devclaw-bot-b00/colima`，未删除／覆盖用户配置。主代理要求后续不得广泛移动／删除默认根，只处理明确本次对象；子代理确认不会再做整根移动。

主代理独立只读核验：默认`~/.colima`、`~/.docker`、`~/.lima`不存在；任务BASE与COLIMA_HOME为0700。当前YAML为2CPU/4GiB/30GiB、aarch64/VZ/Rosetta，唯一挂载runtime只读，autoActivate/SSH config/forwardAgent/Kubernetes/address/hostAddresses关闭，docker/env为空、provision空。进程快照见PID49511执行任务profile启动，尚不能据此判定VM启动成功。原根目录旧内容归属依赖子代理当时inventory，主代理没有伪称事前亲自检查。

需最终确认实际生效的VM/Lima配置、socket/daemon身份、镜像架构／digest、随机秘密文件权限、容器/volume/network标签及回环端口。配置文本正确不替代执行型验证。

## 验收仍待

任务B00所有完整验收项及独立复验均待候选。不能用本机native MySQL通过、manifest查询、工具安装成功或VM配置存在替代容器JDBC/持久化/隔离/清理测试。

## 22:14 UTC恢复独立核对

实际代码03de1a54、报告65be9662且clean。主代理再次读完整host/lifecycle/compose/Java probe代码；E1语义校验与E2全部端口/精确挂载/当前进程对象和inode认领均在草稿中，E2负例仍待。没有将草稿自测升级为冻结候选验收。

上次下载句柄41386不可查询，但实际专用VM与daemon已运行：Colima list exit0、aarch64/2CPU/4GiB/30GiB，显式私有client/socket docker info exit0、namecolima-devclaw-bot/engine29.5.2，ps -a空。Lima实际唯一host mount是runtime只读，SSH agent和宿主pubkey加载关闭。旧Node/Colima创建者已退出，专用Lima/SSH服务仍运行。原代理quota-errored停止，额度恢复后已followup原代理，live status running；无新写者。

冻结后独立验收顺序：核对范围/候选SHA和无写者 → 配置策略负例 → 完整真实Docker/JDK8测试（独立唯一测试project；与实施者串行，避免生命周期竞争）→ 宿主loopback监听与实际资源隔离/清理 → F03/F05mock/node/web回归 → 冻结字节与测试结果核对后集成。不允许凭脚本输出成功而省略真实容器/资源证据。

文档需区分30GiB稀疏数据盘和20GiB稀疏系统盘；MySQL5.7旧版本仅本地隔离开发，不宣称生产安全支持。VM通用portForward配置含0.0.0.0段，容器实际绑定及宿主监听必须证实127.0.0.1。
