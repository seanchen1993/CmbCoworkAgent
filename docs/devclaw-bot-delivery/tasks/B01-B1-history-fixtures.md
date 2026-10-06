# B01-B1 v2.2：实际迁移history的隔离测试夹具

2026-10-06 · ready · 仅修正本片测试，不新增产品能力或运行时配置口

## 实际发现

codeb18ebf37的30892实际exit1：新test-fdce9176117ed318/mysqlab4ab2d2/12732883已首次migration1、no-op0、store/reload成功，随后history PROBE_ASSERTION失败，精确finally回收。Flyway7.15真实Connection构造在原autocommit=false时setAutoCommit(true)，测试不能假定未提交fixture可rollback恢复。该失败由十列事实比较捕获，保留cfea745e报告，不计完整B1通过。

主代理选择 **仅测试main管理已知、可回收的数据库fixture**，不新增MigrationRunner生产history selector或替身，不修改固定classpath/V1/runner/生产readiness，不调用Flyway repair/clean，不升级JDK/MySQL。只在同进程owner-checked新空测试项目、已正确迁移的测试DB上执行，原dev数据/账号/三服务不动。

## 每个固定用例的顺序

1. 核对原history恰一行installed_rank1、version1/SUCCESS/固定脚本/checksum，完整保存十列事实；保存前实际readiness正确。只五个编译期固定用例：旧version0、未知version999、checksum+1、success0、删除准确installed_rank1行；没有输入SQL/标识符选择口。
2. 该固定测试修改显式commit，随后捕获完整mutated事实，明确验证恰为预期五种之一；不能依赖同连接rollback或在Flyway外伪造拒绝。实际固定MigrationRunner.requireCurrent读取此真实history，必须MIGRATION_INVALID。
3. 再读history，须与mutated事实完全相等，证明运行时没有repair/重写/偷偷迁移。任何数量、字段或状态不符合预期即失败并停止此轮，不盲目恢复未知变化，不把状态损坏当下一fixture起点。
4. 仅测试main以原快照参数化恢复准确installed_rank1完整行：有行时UPDATE、缺行时INSERT，显式commit；不delete整表/drop/reset/动态SQL、不repair运行时，不能复制异常message作诊断。恢复是事先定义的夹具tear-down，不是掩盖程序或DDL失败的恢复回退。恢复后完整十列facts与original完全相同，再actualreadiness；下一用例从此已证明正确的状态开始。
5. 若期望拒绝失败，仍报告真实失败；只有明确mutated事实未意外变化才允许预定义fixture收尾，不能把收尾后ready当该拒绝用例通过。实际意外变化/清理失败分别记录，不能吞异常。最终项目finally只精确回收自己的测试容器/网络/卷/目录。

应用运行时永远不写这些恢复SQL或接收history/table selector。实际MySQL5.7迁移失败不自动repair，源码SQL/checksum不改变；测试固定范围由新空可回收数据库隔离，不扩展到现存dev或任何真实外部库。

## 接续与验收

同原gpt-6.1-sol/high `/root/b01_contracts_high` / B01-A02、工作树 `/Users/heyirui/.codex/worktrees/devclaw-bot-local/cmbCowork`、branchcodex/devclaw-bot-local，codeb18ebf37/reportcfea745e已实际停写clean/全部句柄闭合；主代理协调文档正常merge后提供确切起点。只允许原B1文件范围及本人A02，预期仅DatabaseIntegrationProbe测试main+必要safe-stage证据和README，不改生产runner或迁移。

此变化后重新真实Java8完整构建20JUnit/同轮1107parity/fatjar/resource/class52/34实际固定库；两个新owner-checked MySQL5.7顺序完整migration/noop/store/reload/五history拒绝及十列不变/恢复、SQLTimeout/坏密码/离线；未ready注入与真实pre-ready/secret阶段SIGTERM/0数据库JVM/精确absence。全部有界，先保存代码和句柄，失败不伪报。之前构建或部分实际DB通过不能替代本轮全套。

最终freeze code/report、clean停写、全部命令确定退出交主代理实际diff与独立完整验证。未主代理接受前不进入C1/HTTP；定时自动续跑仍PAUSED。
