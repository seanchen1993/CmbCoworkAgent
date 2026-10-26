---
name: autobiz-native-design
description: 生成实际设计契约并等待Host对成果版本的人工确认
---

读取上游需求、PRD和规格bundle，基于真实代码探索或明确标记的新项目假设编制设计。
输出 `DESIGN.bundle.json`：`{feature,stage:"design",files:{"design.md":文本,
".design-contract.lock.json":JSON文本}}`。

design 必须包含 Context / 输入上下文、Code Evidence、Spec Traceability、API Decisions、
Data Decisions、Technical Design、Risks / Open Questions。API-NNN、DATA-NNN、D-NNN
以表格行定义且唯一，引用的 DEC-NNN 必须在 proposal Decision Log 定义。
写出布尔标记 `x-auto-no-http-api: true/false`、`x-auto-no-sql: true/false`，与实际定义一致。
不遗留模板指导、待确认或读码差异表格单元。专业争议在当前任务请用户澄清。

锁文件沿用 version:1、featureId、lockOwner:"dev.design"、lockedAt、designContract。
designContract 含 design.md UTF-8字节的 sha256、排序的 apiIds/dataIds/decisionIds、
noHttpApi、noSql。使用确定性哈希工具计算，不编造摘要。检查器会重新读取并比较全部字段。
该锁是产物一致性记录；真正的设计批准由 Host 在检查成功后绑定此次成果版本并请求用户。

## 精确设计格式与锁生成

files 恰含 design.md 和 .design-contract.lock.json 两个文本值；不把上游文档或新的 UI_CONTEXT 放进 DESIGN bundle。每个文本不超过20000 UTF-8字节，整个 bundle 不超过28000字节。采用 UTF-8、LF 换行；锁的 sha256 哈希对象是 **files["design.md"] 解码后的完整文本再编码成 UTF-8 的字节**，包括最终换行，不是 JSON 转义后的片段或整个 DESIGN.bundle.json。设计正文发生任何字节变化必须重算锁。

结束阶段前必须读取实际已保存的 `DESIGN.bundle.json` 做 UTF-8 字节自检。整个文件小于28000字节不代表内部文本满足20000字节限制；中文与补充平面字符不能按字符数或 UTF-16 长度估算。按下列程序以 `python -I -B -X utf8 <自检脚本.py>` 检查，失败时精简重复说明、保留必要设计并重算锁，再重新检查；不得截断文本、删除业务契约或提高上限。此自检不写文件、不批准成果，也不替代 Host 原业务检查。

<!-- autobiz-design-size-check:start -->
```python
import json
from pathlib import Path


raw = Path("DESIGN.bundle.json").read_bytes()
assert len(raw) <= 28000, "DESIGN_BUNDLE_UTF8_BYTES_EXCEEDED"
bundle = json.loads(raw.decode("utf-8", errors="strict"))
assert set(bundle["files"]) == {"design.md", ".design-contract.lock.json"}
for text in bundle["files"].values():
    assert isinstance(text, str) and text.strip(), "DESIGN_FILE_TEXT_REQUIRED"
    assert len(text.encode("utf-8", errors="strict")) <= 20000, "DESIGN_FILE_UTF8_BYTES_EXCEEDED"
```
<!-- autobiz-design-size-check:end -->

七个正式章节按上文准确名称编写。布尔标记必须独占一行，例如 `x-auto-no-http-api: false` 和 `x-auto-no-sql: true`；不能写 `[true/false]`、尾随说明、字符串 JSON 或把整行塞入表格。API/DATA/D 的定义行必须从 `| API-001 |` / `| DATA-001 |` / `| D-001 |` 开始，ID 单独占第一列，不加反引号/粗体。同类 ID 不得重复，包括不能在另一张追踪表首列重新“定义”同一 ID；普通引用放在正文或其他列。DEC 属于规格决策，必须回指 proposal 的 Decision Log；D 属于本设计决策，不可混用。

无 HTTP API 时 noHttpApi=true 且 apiIds=[]、正文没有 API 定义；无 SQL 时 noSql=true 且 dataIds=[]、正文没有 DATA 定义。不要为了空数组删除真实接口或数据设计。没有设计决策时 decisionIds 可为空。正文不得保留外层 Markdown 代码围栏、`# 技术设计模板`、用于指导作者的引用块 `>` 或 `| 待确认 |` / `| 读码差异 |` 单元格。待裁定问题先向用户澄清，真实风险仍记录在 Risks / Open Questions，不能靠改状态词掩盖。

锁精确结构为 `{version:1,featureId,lockOwner:"dev.design",lockedAt,designContract:{sha256,apiIds,dataIds,decisionIds,noHttpApi,noSql}}`。featureId 与本任务一致，lockedAt 填本次实际记录时间的非空字符串（建议 UTC ISO8601），不是用户批准时间。三个 ID 数组分别只含正文定义的 API-NNN/DATA-NNN/D-NNN，去重后字典序排序；摘要是64位小写十六进制。

以下纯标准库程序只读取 stdin 的 `{feature,lockedAt,design}` 并输出派生锁，不写业务产物、不批准设计，也不替代原校验器。由你先依据实际规格完成设计，再以其精确文本运行本程序并将 stdout 作为锁文本写入 bundle。示例代码不能作为 design.md 正文。

<!-- autobiz-design-lock-helper:start -->
```python
import hashlib
import json
import re
import sys


def derive_design_lock(payload):
    text = payload["design"]
    if not isinstance(text, str) or not text or "\r" in text:
        raise ValueError("DESIGN_REQUIRES_NONEMPTY_LF_TEXT")
    if not all(isinstance(payload[key], str) and payload[key].strip()
               for key in ("feature", "lockedAt")):
        raise ValueError("DESIGN_LOCK_IDENTITY_REQUIRED")

    def marker(name):
        for raw in text.splitlines():
            line = raw.strip()
            if len(line) >= 2 and line[0] in "-*+" and line[1].isspace():
                line = line[2:].strip()
            line = line.replace("**", "")
            match = re.fullmatch(re.escape(name) + r"\s*:\s*(true|false)", line, re.I)
            if match:
                return match.group(1).lower() == "true"
        raise ValueError("DESIGN_BOOLEAN_MARKER_REQUIRED:" + name)

    def ids(prefix):
        values = re.findall(r"^\|\s*(" + prefix + r"-\d{3})\s*\|", text, re.M)
        if len(values) != len(set(values)):
            raise ValueError("DESIGN_DUPLICATE_ID:" + prefix)
        return sorted(values)

    contract = {
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "apiIds": ids("API"), "dataIds": ids("DATA"), "decisionIds": ids("D"),
        "noHttpApi": marker("x-auto-no-http-api"), "noSql": marker("x-auto-no-sql"),
    }
    if (contract["noHttpApi"] and contract["apiIds"]
            or contract["noSql"] and contract["dataIds"]):
        raise ValueError("DESIGN_MARKER_CONFLICTS_WITH_IDS")
    return {"version": 1, "featureId": payload["feature"], "lockOwner": "dev.design",
            "lockedAt": payload["lockedAt"], "designContract": contract}


if __name__ == "__main__":
    print(json.dumps(derive_design_lock(json.load(sys.stdin)), ensure_ascii=False))
```
<!-- autobiz-design-lock-helper:end -->

### Windows 与其他平台的 UTF-8 执行约定

主程序和每个 Python 子程序都显式使用 `python -I -B -X utf8 ...`。仅主程序加 `-X utf8` 不会自动为 `subprocess` 启动的子程序继承该参数；Windows 默认 GBK 解码 UTF-8 stdin 可能产生 `\udc80` 一类代理字符，使后续哈希编码失败。将上面的纯 helper 原文保存为 UTF-8（无 BOM），不要修改其算法。编排程序也以 `python -I -B -X utf8 <编排程序.py>` 启动；读取设计使用明确 UTF-8，并保留 LF 与最终换行。

子调用可采用下面任一分支。文本 input 必须显式 `encoding="utf-8"`；bytes input 必须先严格编码 UTF-8，子程序仍带 `-X utf8`，stdout 再严格按 UTF-8 解码。不要使用 `errors="replace"/"ignore"`、GBK 往返、添加/剥除 BOM 或删除中文来掩盖错误。哈希对象始终是已完成设计的实际 UTF-8 字节，不能通过编码“修复”悄悄改变设计。

<!-- autobiz-design-utf8-launcher:start -->
```python
import json
import subprocess
import sys


def run_utf8_helper(helper_path, payload, as_bytes=False):
    argv = [sys.executable, "-I", "-B", "-X", "utf8", str(helper_path)]
    text = json.dumps(payload, ensure_ascii=False)
    if as_bytes:
        result = subprocess.run(argv, input=text.encode("utf-8"), capture_output=True,
                                check=True, timeout=30)
        return json.loads(result.stdout.decode("utf-8"))
    result = subprocess.run(argv, input=text, encoding="utf-8", capture_output=True,
                            check=True, timeout=30)
    return json.loads(result.stdout)
```
<!-- autobiz-design-utf8-launcher:end -->
