# M05 DeepSeek 配置与显式模型选择修复

2026-10-20。用户授权仅修复模型 fetch failed 和手动模型选择保持问题，不恢复完整功能验证。

## 原因与改动

当前 UI 预览复制了 custom-models.json 和 settings.json，遗漏对应 .env 凭据。原全局/旧预览 DeepSeek 凭据存在且一致；专家 Bot 的 SQLite model_ref 始终为 custom:cheap，并非用户没有保存。旧 app.log 的 pinned 记录显示 requestedModelId=custom:cheap，resolvedModelId=builtin:minimax-m2p5-229b-w8a8，随后 fetch failed。故障请求实际没有使用选中的 DeepSeek。

root 仅将已有 cheap 对应凭据恢复到同一预览 .env（0600，原配置不改，未输出秘密），不复制其他凭据；同 profile 重启以重新读缓存。新启动器 `/tmp/m05-open-connected-preview.cjs` 保留原本地数据，去掉旧 UI 预览的人为失效代理。代理是否参与此前失败未单独实测，不将它认定为唯一原因。

sol/xhigh 的产品修复为 1c1f9b1a，最终 852fc3e466f23486482b21e9ea326aa98f9043f2（末提交仅测试格式与类型）：明确 pinned 模型缺配置或凭据时抛可操作错误，标准主/任务路由不吞此错误、不默换供应商；auto 和未指定模型仍采用原行为。错误不包含URL或凭据。模型参数和用户选择不重写。

## 验收证据

- root 阅读全部产品/测试改动，独立3文件17项通过：`/tmp/m05-root-model-selection-tests.log`。覆盖缺配置、缺凭据、补齐后同ref、未指定默认、auto以及错误在provider构造前传播。
- sol 的17关键项、2项Bot默认模型检查、Node类型、隔离build通过，日志 `/tmp/m05-pinned-model-{second,bot,node,build}.log`。首轮测试fixture漏mock失败留在first.log，补齐后通过。
- 原生UI重启后专家模型仍显示 deepseek-v4-flash，右侧原示例任务和交办内容保留。主界面模型菜单 DeepSeek 从“未配置密钥”恢复可选，已选回DeepSeek。
- 在原“示例｜周末读书会通知”里只提交一次虚构文字请求；日志 requestedModelId=resolvedModelId=custom:cheap，实际 deepseek-v4-flash SSE HTTP200，1个ModelResponse、errorEvents=0、doneEvents=1、afterTool=false。原生UI实际显示通知正文与右侧“已回复”。
- SQLite原执行cancelled、新执行completed，业务任务仍active，未代用户确认完成；专家model_ref和settings默认均custom:cheap。模型参数与原始配置一致，模型文件和.env均0600。

## 留存与边界

App77657 / supervisor77648 / exec73160 在同一隔离profile继续运行，启动器和进程信息见profile/preview-process.json，操作前仍需重查。UI目前停在示例通知回复页；无新独立任务、文件操作或完整确认/退回旅程验收。原用户App/Java/数据未改，真实IM与M05-04/05完整验证继续暂停。当前只验收该窄修复；未将包含未验收04的整条分支合入integration，也未push/deploy/恢复定时。候选树干净、sol停写；root文档单独保存。
