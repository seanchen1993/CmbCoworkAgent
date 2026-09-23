# 授权查询编译复用 — 2026-09-24

基线 be5dd56b，仅 Mods v2 工作树。性能分段诊断发现增量主要在 provider 收到请求前；主进程 CPU 采样中存在授权 SELECT 的 prepare 开销。本次只复用单个数据库连接的查询语句，不缓存授权结果，不改变查询时点、epoch/digest 检查、SQLite WAL/FULL 或外部撤权可见性。

## 失败先行与实现

- 真实 SQLite 1000 次流片段授权检查先失败：预期仅编译一次，实际1001次；另2项外部连接/生命周期检查基线通过。日志 grant-query-red。
- ModControlStore.getGrant 使用惰性连接内 prepared statement；每次调用仍执行 get，并创建独立结果对象。关闭数据库后旧语句失效，新连接重新编译。
- 外部事务未提交时依原 SQLite 可见性，提交撤权后下次读取立即拒绝；重新授权的旧 epoch、摘要更改、删除授权也拒绝。不同项目、返回对象修改、两个数据库及重开均隔离。
- 追加真实双 QuickJS / FunctionModsManager / FunctionSession：外部 SQLite 撤权及重新授权后旧 live guest 均被拒绝。

## 当前验证

- 窄测4文件67通过；新增真实session和物理崩溃回归后3文件8通过。
- 真实 utility process 41 checks 通过，exec63563 exit0已确认。
- 最终 Node/Web 通过；Mods46 **136files1207PASS**，另 renderer 滚动 race 1file2PASS（默认 test:mods 不包含它）。完整 Electron **186 checks PASS**，exec80399 exit0确认，普通 out 已恢复。新测试lint零警告；原control-store3处格式警告经HEAD比对不增。独占标准性能smoke已完成（exec84541 exit0）：`desktop-performance-2026-09-23T23-55-02-416Z-smoke-a73ddf4c/`，qualified=false/passed=false；off/on各2样本TTFT p95 112.1/186.8ms，增量74.7ms；吞吐比1.003621，约1秒idle delta1.796212单核百分点。样本不足以证明性能改善，正式门槛仍未通过。
- 生产改动仅连接字段及getGrant；没有修改实际授权数据、其他业务模块或UAT。代码检视确认无行结果缓存和任何权限跳过。

## 定位证据与边界

- 未插桩生产代码的 stream-phases（8实际插件4Pane、off/on各4）：preProvider均值80.834→139.070ms，producer25.226→26.207ms，postFirstWrite3.490→10.698ms。同机 performance.timeOrigin+now 分段只供诊断，不是跨进程精度/正式门槛证明。
- 侵入式主进程 CPU profile（stream-profile-result）采样包含GC扰动，不把单样本off/on差异当性能结果；on窗口getModsGlobalEnabled约12.3ms、hasSources约9.38ms、grant检查约3.14ms，提示还有其他开销。
- 只记录消息元数据的 stream-ipc-result：两个示例从first turn.step invoke到末层stream.pull约8.2/8.7ms；真正进入第一层前已113.8/130.5ms。没有提前拉下游，也没有跳过透传插件。该诊断只存在忽略目录，不进入产品。
- 旧正式TTFT+67.7ms与ingress关闭1/10组超预算仍未过，不能声称本次小优化解决全部性能门槛。2h10000长稳及Actions交付未完成。
