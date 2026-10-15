# R01-A10 · root 串行报告

2026-10-15 用户明确不展示Group、不要求旧版兼容；仅清理首版界面与旧renderer操作，不扩大到删除内部任务/授权模型或数据库资料。

起点：集成树codex/devclaw-bot-integration/2f0d6c3f；49项既有dirty保留（产品/测试/脚本42），原17任务记录保留。现有代理均completed/errored、无实施写者。实际App92595/Java92534仍运行；仅UI和IPC变更，无需服务/数据库迁移。暂不重启，先完成测试，再核对用户在途任务。

下一步：删除界面兼容分支、移除旧renderer IPC、补展开高级设置的负向UI断言和权限撤销回归，再跑类型/IPC/App/浏览器并记录实际结果。

## 实施检查点

- 页面Group编号、旧配置恢复、采用切换及团队记忆入口已删除；GroupMemoryPanel源码移除（Git可恢复），无数据库/用户数据删除。固定renderer IPC从27收敛为17，撤销入口改为revokeLocalAuthorization，仍走原服务端授权校验。后台自动Group与任务关系保持不动。
- IPC23648/4bec7b exit0，14项全部通过；主端类型22263/bfb79e exit0。首次实际Chromium34288/4d6ca6因新测试先“撤销授权”再点击已不存在的“停止本机”超时；这是测试操作顺序错误，撤销断言移到停止/离线/维护权回归之后，不改产品逻辑、不删断言。重跑待取；Web类型53997待取。
- 最终浏览器20863/f6ecee exit0，实际React/Chromium+fakeIPC：新建前/后/结果后三次展开高级均无Group/团队/旧版，底层旧方法调用即断言失败；记忆检索编辑停用、启用确认可取消、撤销本机授权、离线不显示缓存及维护权丢失仍可看任务结果均通过。93832/457112 exit0，60项client/config/controller/worker/expert/现有执行图测试全过；Web53997/444c24 exit0。所有测试临时窗口/目录已由finally关闭回收。
- CUA只读核对实际App92595仍为旧产物、无专家/节点未启用/无Run，下一明确stop再安全重建重开，保留私有profile和Partner库；不把测试stub页面说成用户已看到新版。

## 最终验收

- 90922/0b93f1 主项目加浏览器测试TypeScript诊断0；14IPC/60App/Web与主端类型/实际ReactChromium结果如上。源码检查：伙伴页无Group/团队/旧版文字，旧10操作不再注册，旧revokeTeam只以revokeLocalAuthorization固定IPC接入现有授权；原后台服务、数据库和自动Group关系未改。GroupMemoryPanel整文件删除，Git可恢复；没有删用户数据。
- 第一次stop3556f6 exit1 PARTNER_PREVIEW，调查dd7bca显示原监督进程已失但App92595仍活，保护守卫拒绝是预期，未停服务/清理数据。CUA确认无专家/启用/Run后正常Cmd+Q，f107ae确认该App退出；再明确stop72298/d91689 exit0，Java/Partner库正常停止、卷和配置保留。没有强杀、放宽进程守卫或修不相关启动器WIP；另一研究工作树的Electron未动。
- 9511/e80fc6 安全完整Electron-vite build/真实Java/MySQL/身份验证完成，App94408、Java94349:55521、监督94211，节点未启用；CUA实际展开高级设置确认仅服务/目录/节点专家ID/撤销/任务执行查询，Group、恢复旧版、团队记忆与采用切换均不存在，随后收起。未代用户创建专家或Run，未调用真实模型。
- 390b46 exit0实际status：App/服务running、Partner数据库healthy，配置/数据preserved。监督9511保留供用户测试，自动续跑PAUSED，不扩后续路线。537c7a原16已提交任务逐对象不变；diff空白检查过。全部43个非docs dirty路径（含之前A9/启动器WIP和一项删除）清单摘要36336f77c2a8f7d21149f7a7137e5d98694eba0d0fdfe1f09e9d862ffdac9292，格式为排序路径逐行“文件SHA256或DELETED＋两空格＋相对路径＋LF”再对UTF8清单SHA256。
