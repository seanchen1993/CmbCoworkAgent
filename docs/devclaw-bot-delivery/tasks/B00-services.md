# B00 v2：MySQL + ES + 本地S3开发依赖

2026-10-04 · ready · 主代理决定；不是生产版本认证

## 授权和模块边界

用户“允许，docker启动es和s3一起吧”：允许既有提案的任务VM内sudo DNS修复，以及Docker中一同启动MySQL/Elasticsearch/S3兼容存储。保留Java应用JDK8、MySQL5.7。ES容器使用自带JDK，与应用JDK8分离；本轮不接Java ES/S3客户端，不实现搜索/文件上传产品API、不改F03契约、不扩B01以外产品路线。F05旧mock入口仍disabled，仅新Docker入口启用本地真实依赖。

准确实施树`/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`，原`/root/b00_local_docker`、gpt-6.1-sol/xhigh、B00-A01，不派生。文件范围沿用B00.md；主代理独占state/HANDOFF/任务/review。先从codeea2ab8e2/report0c703501核对真实Git和资源，再修复；不重复安装/重建VM。

## DNS修复小步骤

仅已认领devclaw-bot VM：核对daemon/profile及原软链接、dnsmasq状态和目标配置缺失，保存备份与归属；参照Colima v0.10.3 dns.go生成`/etc/dnsmasq.d/01-colima.conf`和`/etc/resolv.conf`，只使用现有私网gateway192.168.5.2与实测VM内部IP，重启dnsmasq。变更限定这两个配置、必要备份与该服务。修复和备份脚本纳入允许的deploy/dev/docker目录，文件编辑遵守apply_patch；guest写入属于受控脚本执行，不临时散布未记录命令。

不要安装/升级guest包、改宿主网络、放宽权限或藏进任意provision；失败核对本人文件/哈希后按备份回滚，不盲目重放未知结果。验证resolver可用、官方registry DNS/TLS可达、原daemonID/挂载/端口策略不变，然后保存快照；不要用combined shell最终exit掩盖前置失败。

## 依赖选择与隔离

- MySQL沿用已验证官方5.7.44精确manifest/ID，不升8。
- Elasticsearch使用官方`docker.elastic.co/elasticsearch/elasticsearch:8.19.22`开发基线，下载前核对tag/arm64 manifest并固定实际digest。单节点、Basic免费功能，不开trial、不Kibana、不关认证；随机秘密文件而非argv/env明文。仅HTTP API发布到127.0.0.1随机端口，不发布transport。可用`node.store.allow_mmap=false`避免要求额外guest sysctl；不得擅自sysctl。容器自带JDK，不改变应用Java8。
- S3采用SeaweedFS **4.48** 官方维护者镜像（从官方仓库核对`chrislusf/seaweedfs`来源/架构/实际tag并固定digest），单实例持久化S3兼容开发服务。必须有随机访问密钥/认证配置，不使用匿名模式或默认凭据；只发布S3 API到127.0.0.1，不发布master/filer/admin/grpc端口。不当作AWS S3或内网产品的全部语义等价。
- 如精确官方镜像不存在/来源或架构无法验证，停该下载并报告，不用latest/第三方未知镜像代替。无需因内部平台版本未知停本地环境。
- 保留任务专用private network/volume/client/profile；三个服务各自具有限CPU/内存/日志/健康检查，非privileged、无host网络、无Docker socket/Home挂载。优先现有4GiB VM，串行测试；若实际容量不足，可在验证v1配置后仅为此profile保留盘增加到最多6GiB（宿主16GiB），同步严格完整配置校验和记录，不改宿主内核设置。
- 每服务独立数据volume、精确标签/挂载/全部端口校验。dev入口一次启动三服务，重复不增加第二套；status报告安全地址/版本/健康，不输出secret。stop保留数据；test唯一project/volume，只收回确切本人资源。

### 本地bridge裁决（2026-10-04）

实际Docker29.5.2上，`internal:true`单网络容器虽healthy且HostConfig记录127.0.0.1映射，但NetworkSettings端口为空，主机JDBC不可达。实施诊断62262 exit0、确切测试资源已清理；[上游同版本报告](https://github.com/moby/moby/discussions/53256)支持该观察，不作为单凭网页验收。主代理允许改为**唯一任务user-defined bridge、internal:false**，网络driver option `com.docker.network.bridge.host_binding_ipv4=127.0.0.1`，每个published port仍显式127.0.0.1。不得用默认bridge、host网络、额外代理或修改宿主/daemon全局配置。

边界变化已向用户说明：这是任务资源隔离和回环入站限制，**不是禁止出网的沙箱**；[Docker官方bridge文档](https://docs.docker.com/engine/network/drivers/bridge/)说明默认masquerading支持出网。测试仍仅明确本地endpoint，不因此授权任何真实内网/AWS/外部业务服务访问。同步验证实际network Driver/Internal/Options/IPv6、精确容器网络成员及全部发布端口/宿主lsof；补网络漂移负例，不弱化其他安全条件。

## 真实验收与交付

MySQL继续原Java8/JDBC两空库、事务/CAS/UTF8/UTC/重启验收。ES：健康、认证、唯一测试index写/读/搜索/删除、错误凭据拒绝、重启数据保留。S3：签名认证、唯一测试bucket/object PUT/GET校验字节hash、LIST/DELETE、匿名/错误签名拒绝、重启对象保留；只删本人合成测试数据。SDK/CLI不得读用户AWS环境/默认profile或访问外网AWS；只用明确loopback endpoint和任务随机秘密。

验证宿主实际监听全为127.0.0.1、资源归属与测试finally/SIGTERM清理。完整启动后保留一套健康dev服务供用户使用（默认不启动登录服务），提供安全endpoint/版本和stop方法。测试服务清理而dev数据保留，不prune/down-v/广泛删除。README说明已测能力与未测S3高级语义、资源开销、版本来源；自测只review_pending，主代理独立复验。

## 已核对官方来源

- [ES 8.19 Docker](https://www.elastic.co/guide/en/elasticsearch/reference/8.19/docker.html)：当前示例8.19.22；实际镜像摘要待拉取核对。
- [SeaweedFS4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48)、[官方S3 API](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)、[官方Compose来源](https://raw.githubusercontent.com/seaweedfs/seaweedfs/4.48/docker/seaweedfs-compose.yml)。仅采用与本地隔离目标相符配置，不照搬宽泛公开端口。
- [MinIO官方仓库](https://github.com/minio/minio)当前归档，本次新环境不默认采用其旧社区镜像，不使用需商业许可的AIStor替代。
