import React, { useState, useCallback, useEffect, useRef } from "react"
import { Plus, Trash2, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
import type {
  HarnessDeployUnitSearchItem,
  HarnessPipelineQueryItem,
  HarnessPipelineLabelItem
} from "@/types"

interface LabelRow {
  deployUnit: string
  deployUnitName: string
  deployUnitSearch: string
  pipeline: string
  pipelineAlias: string
  baseLabel: string
  targetLabel: string
}

interface KnowledgeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (content: string) => void
  projectNumber: string
  leanToken: string
}

const MAX_ROWS = 10
const DEPLOY_UNIT_SEARCH_MIN_CHARS = 2

export function KnowledgeDialog({ open, onOpenChange, onSubmit, projectNumber, leanToken }: KnowledgeDialogProps): React.JSX.Element {
  const [labelRows, setLabelRows] = useState<LabelRow[]>([{
    deployUnit: "",
    deployUnitName: "",
    deployUnitSearch: "",
    pipeline: "",
    pipelineAlias: "",
    baseLabel: "",
    targetLabel: ""
  }])

  const [deployUnits, setDeployUnits] = useState<HarnessDeployUnitSearchItem[][]>([[]])
  const [loadingDeployUnits, setLoadingDeployUnits] = useState<boolean[]>([false])
  const [deployUnitPopoverOpen, setDeployUnitPopoverOpen] = useState<boolean[]>([false])
  const [deployUnitErrors, setDeployUnitErrors] = useState<(string | null)[]>([null])

  const [pipelines, setPipelines] = useState<HarnessPipelineQueryItem[][]>([[]])
  const [loadingPipelines, setLoadingPipelines] = useState<boolean[]>([false])

  const [labels, setLabels] = useState<HarnessPipelineLabelItem[][]>([[]])
  const [loadingLabels, setLoadingLabels] = useState<boolean[]>([false])

  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const scrollAreaRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) {
      setLabelRows([{
        deployUnit: "",
        deployUnitName: "",
        deployUnitSearch: "",
        pipeline: "",
        pipelineAlias: "",
        baseLabel: "",
        targetLabel: ""
      }])
      setDeployUnits([[]])
      setLoadingDeployUnits([false])
      setDeployUnitPopoverOpen([false])
      setDeployUnitErrors([null])
      setPipelines([[]])
      setLoadingPipelines([false])
      setLabels([[]])
      setLoadingLabels([false])
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const fetchDeployUnits = useCallback(async (index: number, keyword: string): Promise<void> => {
    if (!keyword.trim()) {
      setDeployUnits(prev => {
        const newUnits = [...prev]
        newUnits[index] = []
        return newUnits
      })
      return
    }

    setLoadingDeployUnits(prev => {
      const newLoading = [...prev]
      newLoading[index] = true
      return newLoading
    })

    try {
      console.log(`[KnowledgeDialog] [searchDeployUnits] input: ${JSON.stringify({ keyword })}`)
      const result = await window.api.harnessBoard.searchDeployUnits({ keyword })
      console.log(`[KnowledgeDialog] [searchDeployUnits] response: ${JSON.stringify(result)}`)
      setDeployUnits(prev => {
        const newUnits = [...prev]
        newUnits[index] = result.deployUnits || []
        return newUnits
      })
      setDeployUnitErrors(prev => {
        const newErrors = [...prev]
        newErrors[index] = null
        return newErrors
      })
    } catch (e) {
      console.error("[KnowledgeDialog] Failed to fetch deploy units:", e)
      setDeployUnits(prev => {
        const newUnits = [...prev]
        newUnits[index] = []
        return newUnits
      })
      setDeployUnitErrors(prev => {
        const newErrors = [...prev]
        newErrors[index] = e instanceof Error ? e.message : "查询失败"
        return newErrors
      })
    } finally {
      setLoadingDeployUnits(prev => {
        const newLoading = [...prev]
        newLoading[index] = false
        return newLoading
      })
    }
  }, [])

  const fetchPipelines = useCallback(async (index: number, deployUnit: string): Promise<void> => {
    if (!deployUnit) {
      setPipelines(prev => {
        const newPipelines = [...prev]
        newPipelines[index] = []
        return newPipelines
      })
      return
    }

    setLoadingPipelines(prev => {
      const newLoading = [...prev]
      newLoading[index] = true
      return newLoading
    })

    try {
      const queryInput = {
        deployUnit,
        env: "UAT",
        orgId: "",
        pageNumber: 1,
        pageSize: 20,
        pipelineTerm: "",
        productTerm: ""
      }
      console.log(`[KnowledgeDialog] [queryPipelines] input: ${JSON.stringify(queryInput)}`)
      const result = await window.api.harnessBoard.queryPipelines(queryInput)
      console.log(`[KnowledgeDialog] [queryPipelines] response: ${JSON.stringify(result)}`)
      setPipelines(prev => {
        const newPipelines = [...prev]
        newPipelines[index] = result.pipelines || []
        return newPipelines
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : "查询流水线失败"
      console.error("[KnowledgeDialog] Failed to fetch pipelines:", e)
      toast.error(message)
      setPipelines(prev => {
        const newPipelines = [...prev]
        newPipelines[index] = []
        return newPipelines
      })
    } finally {
      setLoadingPipelines(prev => {
        const newLoading = [...prev]
        newLoading[index] = false
        return newLoading
      })
    }
  }, [])

  const fetchLabels = useCallback(async (index: number, pipelineName: string): Promise<void> => {
    if (!pipelineName) {
      setLabels(prev => {
        const newLabels = [...prev]
        newLabels[index] = []
        return newLabels
      })
      return
    }

    setLoadingLabels(prev => {
      const newLoading = [...prev]
      newLoading[index] = true
      return newLoading
    })

    try {
      const queryInput = { pipelineName }
      console.log(`[KnowledgeDialog] [queryPipelineLabels] input: ${JSON.stringify(queryInput)}`)
      const result = await window.api.harnessBoard.queryPipelineLabels(queryInput)
      console.log(`[KnowledgeDialog] [queryPipelineLabels] response: ${JSON.stringify(result)}`)
      setLabels(prev => {
        const newLabels = [...prev]
        newLabels[index] = result.labels || []
        return newLabels
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : "查询Label失败"
      console.error("[KnowledgeDialog] Failed to fetch labels:", e)
      toast.error(message)
      setLabels(prev => {
        const newLabels = [...prev]
        newLabels[index] = []
        return newLabels
      })
    } finally {
      setLoadingLabels(prev => {
        const newLoading = [...prev]
        newLoading[index] = false
        return newLoading
      })
    }
  }, [])

  const handleDeployUnitSearchChange = (index: number, value: string) => {
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        deployUnitSearch: value
      }
      return newRows
    })
  }

  const handleDeployUnitSearchKeyDown = (
    index: number,
    event: React.KeyboardEvent<HTMLInputElement>
  ): void => {
    if (event.key !== "Enter") return
    event.preventDefault()
    const keyword = labelRows[index]?.deployUnitSearch ?? ""
    if (keyword.trim().length >= DEPLOY_UNIT_SEARCH_MIN_CHARS) {
      setDeployUnitPopoverOpen(prev => {
        const newOpen = [...prev]
        newOpen[index] = true
        return newOpen
      })
      void fetchDeployUnits(index, keyword)
    }
  }

  const handleDeployUnitSelect = (index: number, deployUnit: HarnessDeployUnitSearchItem) => {
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        deployUnit: deployUnit.deployUnit,
        deployUnitName: deployUnit.deployUnitName || "",
        deployUnitSearch: "",
        pipeline: "",
        pipelineAlias: "",
        baseLabel: "",
        targetLabel: ""
      }
      return newRows
    })

    setDeployUnits(prev => {
      const newUnits = [...prev]
      newUnits[index] = []
      return newUnits
    })

    setDeployUnitPopoverOpen(prev => {
      const newOpen = [...prev]
      newOpen[index] = false
      return newOpen
    })

    clearDeployUnitDependentState(index)

    void fetchPipelines(index, deployUnit.deployUnit)
  }

  const clearDeployUnitDependentState = (index: number) => {
    setPipelines(prev => {
      const newPipelines = [...prev]
      newPipelines[index] = []
      return newPipelines
    })

    setLabels(prev => {
      const newLabels = [...prev]
      newLabels[index] = []
      return newLabels
    })

    setLoadingPipelines(prev => {
      const newLoading = [...prev]
      newLoading[index] = false
      return newLoading
    })

    setLoadingLabels(prev => {
      const newLoading = [...prev]
      newLoading[index] = false
      return newLoading
    })
  }

  const handleDeployUnitClear = (index: number) => {
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        deployUnit: "",
        deployUnitName: "",
        deployUnitSearch: "",
        pipeline: "",
        pipelineAlias: "",
        baseLabel: "",
        targetLabel: ""
      }
      return newRows
    })

    setDeployUnits(prev => {
      const newUnits = [...prev]
      newUnits[index] = []
      return newUnits
    })

    setDeployUnitErrors(prev => {
      const newErrors = [...prev]
      newErrors[index] = null
      return newErrors
    })

    setDeployUnitPopoverOpen(prev => {
      const newOpen = [...prev]
      newOpen[index] = false
      return newOpen
    })

    clearDeployUnitDependentState(index)
  }

  const handlePipelineSelect = (index: number, value: string) => {
    const pipeline = pipelines[index]?.find(p => p.pipeline === value)
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        pipeline: value,
        pipelineAlias: pipeline?.pipelineAlias || "",
        baseLabel: "",
        targetLabel: ""
      }
      return newRows
    })

    setLabels(prev => {
      const newLabels = [...prev]
      newLabels[index] = []
      return newLabels
    })

    void fetchLabels(index, value)
  }

  const handleBaseLabelSelect = (index: number, value: string) => {
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        baseLabel: value
      }
      return newRows
    })
  }

  const handleTargetLabelSelect = (index: number, value: string) => {
    setLabelRows(prev => {
      const newRows = [...prev]
      newRows[index] = {
        ...newRows[index],
        targetLabel: value
      }
      return newRows
    })
  }

  const addRow = () => {
    if (labelRows.length < MAX_ROWS) {
      setLabelRows(prev => [...prev, {
        deployUnit: "",
        deployUnitName: "",
        deployUnitSearch: "",
        pipeline: "",
        pipelineAlias: "",
        baseLabel: "",
        targetLabel: ""
      }])
      setDeployUnits(prev => [...prev, []])
      setLoadingDeployUnits(prev => [...prev, false])
      setDeployUnitPopoverOpen(prev => [...prev, false])
      setDeployUnitErrors(prev => [...prev, null])
      setPipelines(prev => [...prev, []])
      setLoadingPipelines(prev => [...prev, false])
      setLabels(prev => [...prev, []])
      setLoadingLabels(prev => [...prev, false])

      requestAnimationFrame(() => {
        const viewport = scrollAreaRef.current?.querySelector<HTMLDivElement>(
          "[data-radix-scroll-area-viewport]"
        )
        if (viewport) {
          viewport.scrollTop = viewport.scrollHeight
        }
      })
    }
  }

  const removeRow = (index: number) => {
    if (labelRows.length > 1) {
      setLabelRows(prev => prev.filter((_, i) => i !== index))
      setDeployUnits(prev => prev.filter((_, i) => i !== index))
      setLoadingDeployUnits(prev => prev.filter((_, i) => i !== index))
      setDeployUnitPopoverOpen(prev => prev.filter((_, i) => i !== index))
      setDeployUnitErrors(prev => prev.filter((_, i) => i !== index))
      setPipelines(prev => prev.filter((_, i) => i !== index))
      setLoadingPipelines(prev => prev.filter((_, i) => i !== index))
      setLabels(prev => prev.filter((_, i) => i !== index))
      setLoadingLabels(prev => prev.filter((_, i) => i !== index))
    }
  }

  const validateForm = (): string | null => {
    for (let i = 0; i < labelRows.length; i++) {
      const row = labelRows[i]
      if (!row.deployUnit) {
        return `第${i + 1}行：请选择发布单元`
      }
      if (!row.pipeline) {
        return `第${i + 1}行：请选择流水线`
      }
      if (!row.baseLabel) {
        return `第${i + 1}行：请选择基础Label`
      }
      if (!row.targetLabel) {
        return `第${i + 1}行：请选择目标Label`
      }
    }

    return null
  }

  const generateContent = (): string => {
    let content = `帮我同步知识库，参数如下：
- 项目编号：${projectNumber.trim()}
- 精益平台token：${leanToken.trim()}`

    labelRows.forEach((row, index) => {
      content += `
- labelList[${index}]：
- 流水线编号：${row.pipeline}
- 发布单元编码：${row.deployUnit}
- 基础label：${row.baseLabel}
- 目标label：${row.targetLabel}`
    })

    return content
  }

  const handleSubmit = async () => {
    const validationError = validateForm()
    if (validationError) {
      setError(validationError)
      return
    }

    setError(null)
    setSubmitting(true)

    try {
      const content = generateContent()
      onSubmit(content)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败")
    } finally {
      setSubmitting(false)
    }
  }

  const handleDialogClose = (openState: boolean) => {
    if (!submitting) {
      onOpenChange(openState)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogClose}>
      <DialogContent className="z-[60] sm:max-w-4xl max-h-[90vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle>知识库沉淀</DialogTitle>
          <DialogDescription>填写相关信息，生成知识库同步请求</DialogDescription>
        </DialogHeader>

        <ScrollArea ref={scrollAreaRef} className="max-h-[60vh] pr-3">
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                  <span>项目编号</span>
                </label>
                <Input
                  value={projectNumber}
                  readOnly
                  className="bg-muted/50"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                  <span>精益平台token</span>
                </label>
                <Input
                  value={leanToken}
                  readOnly
                  className="bg-muted/50"
                />
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-foreground">发布单元列表</h3>

              <div className="space-y-3">
                {labelRows.map((row, index) => (
                  <div
                    key={`label-row-${index}`}
                    className="rounded-md border border-border p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-muted-foreground">
                        第 {index + 1} 行
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRow(index)}
                        disabled={submitting || labelRows.length === 1}
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      {/* Row 1: Step1 + Step2 */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <label className="flex items-center gap-2 text-sm font-medium text-foreground">
                            <span>
                              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">Step1</span>
                            {" 发布单元"}
                          </span>
                          <span className="text-destructive">*</span>
                          <span className="text-xs font-normal text-muted-foreground">Enter查询</span>
                        </label>
                        <Popover
                          modal={false}
                          open={deployUnitPopoverOpen[index]}
                          onOpenChange={(nextOpen) => {
                            setDeployUnitPopoverOpen(prev => {
                              const newOpen = [...prev]
                              newOpen[index] = nextOpen
                              return newOpen
                            })
                          }}
                        >
                          <PopoverAnchor asChild>
                            <div className="relative">
                              <Input
                                value={row.deployUnit ? (row.deployUnitName ? `${row.deployUnitName} (${row.deployUnit})` : row.deployUnit) : row.deployUnitSearch}
                                onChange={(e) => {
                                  if (row.deployUnit) {
                                    handleDeployUnitClear(index)
                                  }
                                  handleDeployUnitSearchChange(index, e.target.value)
                                }}
                                onKeyDown={(e) => handleDeployUnitSearchKeyDown(index, e)}
                                placeholder="请输入关键字"
                                disabled={submitting}
                                className={row.deployUnit ? "pr-7" : ""}
                              />
                              {row.deployUnit && !submitting && (
                                <button
                                  type="button"
                                  aria-label="清除发布单元"
                                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                                  onMouseDown={(e) => {
                                    e.preventDefault()
                                    handleDeployUnitClear(index)
                                  }}
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </div>
                          </PopoverAnchor>
                          <PopoverContent
                            align="start"
                            sideOffset={4}
                            className="z-[70] w-[var(--radix-popover-trigger-width)] p-1"
                          >
                            <div className="max-h-72 overflow-hidden text-sm">
                              {row.deployUnitSearch.length < DEPLOY_UNIT_SEARCH_MIN_CHARS ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">
                                  输入至少 {DEPLOY_UNIT_SEARCH_MIN_CHARS} 个字符后Enter查询
                                </div>
                              ) : loadingDeployUnits[index] ? (
                                <div className="flex items-center gap-2 px-3 py-2">
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                  <span className="text-xs">加载中...</span>
                                </div>
                              ) : deployUnitErrors[index] ? (
                                <div className="px-3 py-2 text-xs text-destructive">
                                  {deployUnitErrors[index]}
                                </div>
                              ) : deployUnits[index]?.length === 0 ? (
                                <div className="px-3 py-2 text-xs text-muted-foreground">
                                  未找到匹配的发布单元
                                </div>
                              ) : (
                                deployUnits[index]?.map((unit) => (
                                  <button
                                    key={unit.deployUnit}
                                    type="button"
                                    className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                                    onClick={() => handleDeployUnitSelect(index, unit)}
                                  >
                                    {unit.deployUnitName ? `${unit.deployUnitName} (${unit.deployUnit})` : unit.deployUnit}
                                  </button>
                                ))
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>
                      </div>

                      <div className="space-y-2">
                        <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                          <span>
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">Step2</span>
                            {" 流水线"}
                          </span>
                          <span className="text-destructive">*</span>
                        </label>
                        <Select
                          value={row.pipeline}
                          onValueChange={(value) => handlePipelineSelect(index, value)}
                          disabled={submitting || !row.deployUnit}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="请选择流水线" />
                          </SelectTrigger>
                          <SelectContent className="z-[70]">
                            {loadingPipelines[index] ? (
                              <div className="flex items-center gap-2 px-2 py-3">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-sm">加载中...</span>
                              </div>
                            ) : pipelines[index]?.length === 0 ? (
                              <div className="px-2 py-3 text-sm text-muted-foreground">
                                请先选择发布单元
                              </div>
                            ) : (
                              pipelines[index]?.map((p) => (
                                <SelectItem key={p.pipeline} value={p.pipeline}>
                                  {p.pipelineAlias} ({p.pipeline})
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {/* Row 2: Step3 + Step4 */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                          <span>
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">Step3</span>
                            {" 基础Label"}
                          </span>
                          <span className="text-destructive">*</span>
                        </label>
                        <Select
                          value={row.baseLabel}
                          onValueChange={(value) => handleBaseLabelSelect(index, value)}
                          disabled={submitting || !row.pipeline}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="请选择基础Label" />
                          </SelectTrigger>
                          <SelectContent className="z-[70]">
                            {loadingLabels[index] ? (
                              <div className="flex items-center gap-2 px-2 py-3">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-sm">加载中...</span>
                              </div>
                            ) : labels[index]?.length === 0 ? (
                              <div className="px-2 py-3 text-sm text-muted-foreground">
                                请先选择流水线
                              </div>
                            ) : (
                              labels[index]?.map((label) => (
                                <SelectItem key={label.label} value={label.label}>
                                  {label.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <label className="flex items-center gap-1 text-sm font-medium text-foreground">
                          <span>
                            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">Step4</span>
                            {" 目标Label"}
                          </span>
                          <span className="text-destructive">*</span>
                        </label>
                        <Select
                          value={row.targetLabel}
                          onValueChange={(value) => handleTargetLabelSelect(index, value)}
                          disabled={submitting || !row.pipeline}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="请选择目标Label" />
                          </SelectTrigger>
                          <SelectContent className="z-[70]">
                            {loadingLabels[index] ? (
                              <div className="flex items-center gap-2 px-2 py-3">
                                <Loader2 className="h-4 w-4 animate-spin" />
                                <span className="text-sm">加载中...</span>
                              </div>
                            ) : labels[index]?.length === 0 ? (
                              <div className="px-2 py-3 text-sm text-muted-foreground">
                                请先选择流水线
                              </div>
                            ) : (
                              labels[index]?.map((label) => (
                                <SelectItem key={label.label} value={label.label}>
                                  {label.label}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    </div>
                  </div>
                ))}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addRow}
                disabled={submitting || labelRows.length >= MAX_ROWS}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                添加一行
              </Button>

              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                生成并提交中...
              </>
            ) : (
              "生成并提交"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}