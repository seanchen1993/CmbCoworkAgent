import { useId, type ReactNode } from "react"
import { cn } from "@/lib/utils"

type RequirementFileDropzoneProps = {
  accept: string
  multiple?: boolean
  disabled?: boolean
  className?: string
  children: ReactNode
  onFilesSelected: (files: File[]) => void
}

export function RequirementFileDropzone({
  accept,
  multiple = false,
  disabled = false,
  className,
  children,
  onFilesSelected
}: RequirementFileDropzoneProps): React.JSX.Element {
  const inputId = useId()

  const selectFiles = (files: FileList | null): void => {
    const selected = Array.from(files ?? [])
    if (selected.length > 0) onFilesSelected(selected)
  }

  return (
    <>
      <label
        htmlFor={disabled ? undefined : inputId}
        onDragOver={(event) => {
          if (!disabled) event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          if (!disabled) selectFiles(event.dataTransfer.files)
        }}
        className={cn(
          "flex min-h-44 w-full cursor-pointer flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed border-[#d8cbbb] bg-[#fdfbf7] px-6 text-center transition-colors hover:border-primary/60 hover:bg-primary/5 focus-within:border-primary",
          disabled && "cursor-not-allowed opacity-60",
          className
        )}
      >
        {children}
      </label>
      <input
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        className="sr-only"
        onChange={(event) => {
          selectFiles(event.target.files)
          event.target.value = ""
        }}
      />
    </>
  )
}
