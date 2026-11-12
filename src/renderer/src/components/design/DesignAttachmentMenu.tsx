import { useRef, type CSSProperties } from "react"
import { ChevronDown, Paperclip } from "lucide-react"
import { hasOpenModalDialog } from "@/lib/modal-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

interface DesignAttachmentMenuProps {
  attachmentLoading: boolean
  importDisabled: boolean
  showContextActions: boolean
  onAssociateTemplate?: () => void
  templateDisabled?: boolean
  onUploadFile: () => void
  onUploadScreenshot: () => void
  onImportPrototypeZip: () => void
  onImportUrl: () => void
  onImportHtml: () => void
  onAttachCode: () => void
}

const buttonStyle: CSSProperties = {
  height: 30,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  padding: "0 6px",
  background: "none",
  border: "none",
  borderRadius: 6,
  color: "#6a6a6a",
  fontFamily: "inherit",
  fontSize: 12,
  whiteSpace: "nowrap",
  cursor: "pointer"
}

export function DesignAttachmentMenu({
  attachmentLoading,
  importDisabled,
  showContextActions,
  onAssociateTemplate,
  templateDisabled,
  onUploadFile,
  onUploadScreenshot,
  onImportPrototypeZip,
  onImportUrl,
  onImportHtml,
  onAttachCode
}: DesignAttachmentMenuProps) {
  const actionAfterCloseRef = useRef<(() => void) | null>(null)
  const selectAfterClose = (action: () => void) => () => {
    actionAfterCloseRef.current = action
  }

  return (
    <div
      role="group"
      aria-label="上传文件与更多选择"
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      <button
        type="button"
        aria-label="上传文件"
        title="附加文档（txt / md / csv / docx / xlsx）"
        disabled={attachmentLoading}
        onClick={onUploadFile}
        style={{ ...buttonStyle, opacity: attachmentLoading ? 0.5 : 1 }}
      >
        {attachmentLoading ? "⏳" : <Paperclip size={15} />}
        上传文件
      </button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="更多上传选项"
            title="更多选择"
            style={{ ...buttonStyle, padding: "0 3px" }}
          >
            <ChevronDown size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          className="w-56"
          onCloseAutoFocus={(event) => {
            const action = actionAfterCloseRef.current
            actionAfterCloseRef.current = null
            if (action) {
              // Finish closing before opening a native picker. Restoring focus to
              // the trigger afterward can take focus from the picker on Windows.
              event.preventDefault()
              action()
              return
            }
            if (hasOpenModalDialog()) event.preventDefault()
          }}
        >
          {onAssociateTemplate && (
            <>
              <DropdownMenuItem disabled={templateDisabled} onSelect={onAssociateTemplate}>
                <span aria-hidden="true">▣</span>关联页面模板
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={selectAfterClose(onUploadScreenshot)}>
            <span aria-hidden="true">🖼️</span>上传截图
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={importDisabled}
            onSelect={selectAfterClose(onImportPrototypeZip)}
          >
            <span aria-hidden="true">📦</span>上传原型图压缩包
          </DropdownMenuItem>
          {showContextActions && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={importDisabled} onSelect={selectAfterClose(onImportUrl)}>
                <span aria-hidden="true">🌐</span>通过内置浏览器打开
              </DropdownMenuItem>
              <DropdownMenuItem disabled={importDisabled} onSelect={selectAfterClose(onImportHtml)}>
                <span aria-hidden="true">📄</span>上传 HTML 文件
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onAttachCode}>
                <span aria-hidden="true">🗂️</span>关联代码
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
