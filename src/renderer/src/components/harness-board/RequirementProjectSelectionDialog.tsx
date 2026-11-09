import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import type { HarnessProjectListItem } from "../../../../shared/harness-board-types"

export function RequirementProjectSelectionDialog({
  open,
  projects,
  loading,
  onOpenChange,
  onSelect,
  onCreate
}: {
  open: boolean
  projects: HarnessProjectListItem[]
  loading: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (project: HarnessProjectListItem) => void
  onCreate: () => void
}): React.JSX.Element {
  const activeProjects = useMemo(
    () => projects.filter((project) => project.lifecycle.status === "active"),
    [projects]
  )
  const [selectedProjectId, setSelectedProjectId] = useState("")
  const selectedProject = activeProjects.find((project) => project.projectId === selectedProjectId)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedProjectId("")
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>补充项目与特性信息</DialogTitle>
          <DialogDescription>
            选择已有项目后，需填写特性名称和会话工作区。新建项目还需填写插件、项目名称与编号、项目目录、系统
            ID 与名称、项目工作区；发布单元和工作流按插件配置补充。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          {loading ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              正在加载项目…
            </div>
          ) : activeProjects.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              暂无可选项目，请新建项目。
            </div>
          ) : (
            <label className="grid gap-1.5 text-sm font-medium">
              选择项目
              <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                <SelectTrigger aria-label="选择已有项目">
                  <SelectValue placeholder="请选择已有项目" />
                </SelectTrigger>
                <SelectContent>
                  {activeProjects.map((project) => (
                    <SelectItem
                      key={project.projectId}
                      value={project.projectId}
                      itemText={project.name}
                    >
                      <span className="ml-2 text-xs text-muted-foreground">
                        {project.projectCode} · {project.systemName}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSelectedProjectId("")
              onCreate()
            }}
          >
            新建项目
          </Button>
          <Button
            type="button"
            disabled={!selectedProject}
            onClick={() => {
              if (!selectedProject) return
              setSelectedProjectId("")
              onSelect(selectedProject)
            }}
          >
            下一步：创建特性
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
