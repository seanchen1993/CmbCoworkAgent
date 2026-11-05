完成。重试机制已扩展到"返回结果解析失败 + 流式输出全空"，实现方式如下：

 ## 改动内容

 **1. `llm_client.py` — `chat()` 新增 `validate` 回调，三层失败统一放在同一个重试循环（共用 `LLM_MAX_RETRIES` 预算）**
 - ① 请求层：网络/HTTP 异常（原逻辑保留）
 - ② 响应解析层：流式/非流式解析异常（原逻辑保留）
 - ③ **业务校验层（新增）**：`validate(result)` 返回 `None` 通过、返回字符串/抛异常则视为失败，「流式全空、JSON 解析失败、部分维度失败」都走这里，和网络失败一样按 `attempt < max_retries` 重试，重试用尽抛 `ValueError`
 - ④ trace 仍在通过后附加

 **2. `auditor.py` — `audit_text_multi` 接入校验并吞掉最终失败**
 - 传入 `_validate_result`：内部执行 `_parse_multi_results`，只要有任一维度 `ok=False`（或空内容→解析不出 JSON）→ 返回校验失败串触发重试
 - `except ValueError` 兜底：重试用尽后**不抛异常**，返回 `ok=False` + 各维度最后一次 `parse_error` 的标准结构（main.py 现有逻辑照常把它记为失败哨兵、写缓存、下次整篇重跑）

 **3. `ab_test.py` — `audit_two_step_multi` 两轮都接入**
 - 第 1 轮要素提取：空内容 / 提取不出 JSON → 重试
 - 第 2 轮断言判定：空内容 / JSON 解析失败 / 部分维度失败 → 重试
 - 同样重试预算用尽后返回 `ok=False` 结构，不再抛到外层

 ## 验证结果（mock `requests.post`，真实走完重试循环）
 | 用例 | 结果 |
 |---|---|
 | 流式全空 → 第2次成功 | PASS |
 | 连续2次解析失败 → 第3次成功 | PASS |
 | 网络异常 → 重试成功（回归） | PASS |
 | 全部失败 → 预算用尽返回 ok=False 不抛 | PASS |
 | 部分维度缺失 → 重试补齐 | PASS |
 | 两轮对话：第1轮空→重试 + 第2轮解析失败→重试 | PASS |

 临时冒烟脚本已删除，全部源码 `py_compile` 通过。日志文案统一为「自动重试」（如 `[重试] LLM输出校验失败(...)：第1次/共4次，10s后自动重试`）。
