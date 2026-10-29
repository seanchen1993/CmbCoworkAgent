/** Known pre-save rejection: no new revision or source directory has been written. */
export class ProjectDraftFileError extends Error {
  readonly unsupportedPaths: readonly string[]
  declare readonly declarationPath?: "composition/source.json"

  constructor(paths: readonly string[], declarationPath?: "composition/source.json") {
    super("PROJECT_DRAFT_FILE_UNSUPPORTED")
    this.unsupportedPaths = [...paths].sort()
    if (declarationPath) this.declarationPath = declarationPath
  }
}

export function projectDraftFileHint(error: ProjectDraftFileError): string {
  const declaration = error.declarationPath
    ? "在同一次 project_patch 中同时补齐 composition/source.json.resources 的精确相对路径和相应 files，原子保存声明与资源。"
    : "先 project_read 核对当前项目格式允许的源码及已有资源声明；仅补齐该格式支持的声明和相应 files，不要自行改成另一种项目格式。"
  return (
    "unsupportedPaths 列出了未获当前源码声明允许的文件；本次保存未开始，源码和 revision 保持不变。" +
    declaration +
    "已有草稿使用返回的 currentDraft.revision/sourceDigest 继续；新草稿修正声明后仍以 revision:0 保存。不能使用 execute、write_file 或直接改安装目录绕过资源检查。保存不代表编译、授权或执行。"
  )
}
