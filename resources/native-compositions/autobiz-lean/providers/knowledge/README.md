# 阶段知识提供器

本包是独立 Function Mod。作者在组合的 `contextAction.config` 中声明 `stageTags`，
键是实际阶段 ID，值是允许选入该阶段的 `autobiz_stages` 标签数组。例如：

```json
{
  "stageTags": { "draft": ["definition"], "review": ["solution", "code"] },
  "knowledgeRoots": ["orders", "shared-product"]
}
```

新增阶段只需更新组合配置，不修改本包的阶段名称列表。缺少当前阶段映射、空标签集合、
非法标签或材料使用未声明标签都会明确拒绝。未标注 `autobiz_stages` 的已选组织知识始终保留，
最近的 `AGENTS.md` 正文始终保留；配置不授予新的文件权限。

`knowledgeRoots` 可省略，省略时保持扫描整个已绑定知识根的行为。若填写，它是知识根内的
相对目录数组，表示作者明确确认的资料覆盖范围，不能包含重叠目录、绝对路径或上级路径。
每次调用重新列举各子树，读取其中实际 Markdown，并额外读取祖先的 `AGENTS.md`。
不会递归列举其他子树或读取它们的文档正文。新增未标注文件会在下一次调用纳入选择；
这里不使用可能过期的文件名索引。结果明确记录覆盖子根，以及子根外仅检查祖先指令的限制。
共享产品知识若在其他目录，作者必须显式加入该目录；缺失所选部署单元资料会报错，不能声称完整检索。

项目模式由 Host 提供特性选中的发布单元和项目绑定的知识库。提供器使用材料根标识读取所选知识库，沿用发布单元、知识类型和最近 AGENTS 的选择规则。独立试跑仍可使用原知识目录和发布单元参数。
`package` 材料根仍需提供 `method.md`。

创造者通过 `catalog(project-dependencies)` 找到本包的真实 `sourceId`，再调用
`dependency_prepare(sourceId)`。目录 ID 由 Host 生成，不是安装 ID 或文件路径。准备操作保留
完整来源、许可证与 provenance，经过实际保存、严格 SDK 预检和原安装确认链。
`frontmatter.cjs` 是原生成第三方库，只增加类型检查注释；原可执行字节不变，原摘要和适配摘要
均记录在 `provenance.json`。第一方知识选择代码仍经过严格类型检查。
