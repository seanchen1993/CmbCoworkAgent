# GitHub Actions Windows包内验证门禁 — 2026-09-24

本次使用既有Actions打包产物，新增script直接运行已构建的dist/win-unpacked/CMBDevClaw.exe，复用现有packaged Electron测试入口。不安装依赖、不rebuild、不build、不生成本地NSIS、不删除或复用旧证据。

## 实现

- Windows Package步骤之后、installer/unpacked上传和draft release之前运行；失败阻止该Windows job后续发布。Linux原有安装/多平台/GLIBC路线不改，不声称Windows测试覆盖Linux。
- 清理继承的focused/source-build/soak入口变量，固定CMB_MODS_PACKAGED_DIR、新证据目录与测试bridge关闭标志；原测试断言实际isPackaged、ASAR、隔离runtime及无测试入口。
- 运行前后绑定EXE与app.asar SHA-256；子进程必须成功退出且留下完整package分支回执；非零退出即使有成功形状JSON也失败。16分钟runner限时，CI步骤20分钟；原E2E自身15分钟关闭应用watchdog继续保留。超时不是通过。
- 输出必须是指定workspace output/mods-v2-validation下的新目录。证据上传只含两个JSON和PNG，未上传用户profile、日志、数据库或env文件。

现有包内测试通过真实preload、安装批准的guest/session、内建esbuild/QuickJS、原生工具、Code worker、焦点和关闭对照执行。启动unpacked应用不是NSIS安装/卸载验证，不声称已交付最新版安装包。

## 已运行

- 先增加runner回归因入口缺失失败（packaged-runner-red.log），再实现后8项通过。真实Node子进程夹具验证控制流和输出，fixture EXE/ASAR仅元数据，不能作为Electron/业务验收。
- 工作流新增门禁前，解析后的step顺序回归失败（packaged-workflow-red.log）；接线后连同既有staging先3文件17项通过；再补真实CLI缺参/Windows大小写路径验证，最终3文件18项通过（packaged-final-tests.log），约2.75秒。
- 独立helper TypeScript与最终6文件差量lint通过（27807exit0，包含另组Client改动；旧root88warnings无新增）。本组没有修改production/application文件。
- 另组Client修复83e3da32已完成Mods1333/utility44/完整Electron226与新普通性能smoke。不能把普通应用套件或Node runner夹具描述成新ASAR/安装包已经通过。
- 代码检视确认仅Windows插入门禁、无continue-on-error、安装包上传/Release保留默认成功前提；always仅用于限定的诊断产物。依赖、环境解密、Linux构建及本地NSIS不改。
- 未push、未触发Actions、未执行本地NSIS。本轮没有实际新package可验收；真实CI结果与安装验证仍待执行，单元夹具结果不得写为业务或发布PASS。
