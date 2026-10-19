通过原“安装插件”入口安装本目录的 ZIP，然后在原生权限卡确认精确来源。
该插件导出 inspect 动作，通过原动作绑定接收 content（交付 JSON 的原始文本）和 requiredIds。
项目动作 inputFrom 使用 artifact + format:text；content 由原宿主读取，禁止常量覆盖。
上游须通过普通 composition 输入绑定复制 verified-context，不能让模型自行声称来源可信。
示例 requiredIds: ["warehouse_sql_results", "warehouse_quality"]。
动作逐项核对 SHA-256、原校验信息和必需 ID，再解析 JSON，返回包含实际数据的确定性报告。
纯动作结果进入原动作/Flow 账本，不声明业务认可、不修改生产者状态。
同一个验证函数也注册为 inspect 工具；须在原生卡确认 tool.register、文件读取和固定报告写入权限。
该工具仅接受所需ID，自行读取固定绑定输入并写入固定报告；模型不能替换输入内容，已有不同报告会拒绝覆盖。
本包可在原组合界面作为普通Host流程选择。任务须明确给出 VERIFIED_REQUIRED_IDS=["所需ID"]，一次且仅一次。
原必需Stop Hook独立读取宿主任务、固定绑定输入与报告逐项精确核对；模型忽略失败也不能完成。
必需环境已在runtime.environment声明为Python 3。请安装Python 3并将python命令加入应用进程的PATH，重启应用后使用。
本包沿原Hook命令解析调用python，不提供第二个解释器绑定入口；仅填写配置或声明环境不会伪装为已安装。
没有可执行环境、Hook超时或检查异常均按原必需检查拒绝完成。场景规则不固化到平台。
这是现有 autobiz-v1 校验适配器的可选导出；其他生产者适配器未支持时必须明确拒绝。
