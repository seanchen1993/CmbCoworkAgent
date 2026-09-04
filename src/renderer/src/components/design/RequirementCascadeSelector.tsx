import { useEffect, useMemo, useState } from "react"
import {
  Check,
  ClipboardList,
  Layers3,
  LoaderCircle,
  Network,
  RefreshCw
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import {
  leanstarRequirementsApi,
  getDetailCode,
  type ImplementationDetail,
  type NamespaceTreeNode,
  type ProductRequirement,
  type RequirementDetail
} from "@/api/leanstar-requirements"

export type NamespaceTreeSelection = {
  namespaceId: string
  pathName: string
  pathId: string
  devopsOrgId: string
  requirement: ProductRequirement
  implementationDetails: ImplementationDetail[]
}

type NamespaceTreeSelectorProps = {
  value: NamespaceTreeSelection | null
  onChange: (selection: NamespaceTreeSelection | null) => void
}

function ErrorMessage({
  message,
  onRetry
}: {
  message: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span>{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 font-medium hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw className="size-3" /> 重试
      </button>
    </div>
  )
}

// 叶子节点 = 没有子节点的最末层节点（组织树最后一层，代表具体开发组/系统）。
function isLeafNode(node: NamespaceTreeNode): boolean {
  return !node.children || node.children.length === 0
}

// 递归收集所有叶子节点，合并为一个扁平 list 作为命名空间下拉的 options。
function collectLeafNodes(nodes: NamespaceTreeNode[]): NamespaceTreeNode[] {
  const result: NamespaceTreeNode[] = []
  const walk = (list: NamespaceTreeNode[]): void => {
    for (const node of list) {
      if (isLeafNode(node)) {
        result.push(node)
      } else if (node.children) {
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return result
}

function getNodeKey(node: NamespaceTreeNode): string {
  return node.pathId || node.devopsOrgId || node.namespaceId || node.pathName
}

function inaccessibleLabel(reason?: string): string | null {
  if (!reason) return null
  if (reason === "UNAUTHORIZED") return "无权限"
  if (reason === "UNSUPPORTED") return "不支持"
  return reason
}

function NamespacePathLabel({
  pathName,
  className
}: {
  pathName: string
  className?: string
}): React.JSX.Element {
  const segments = pathName
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
  const lastSegment = segments.at(-1) ?? pathName
  return (
    <span className={cn("flex min-w-0 items-center justify-start text-left", className)} title={pathName}>
      <span className="min-w-0 truncate">{lastSegment}</span>
      {pathName && pathName !== lastSegment && (
        <span className="ml-1 min-w-0 truncate text-muted-foreground">({pathName})</span>
      )}
    </span>
  )
}

function getOwnerLabel(owner: ProductRequirement["owner"]): string {
  if (!owner) return ""
  if (typeof owner === "string") return owner
  const name = owner.name?.trim()
  const id = owner.id?.trim()
  if (!name && !id) return ""
  return `(${id ?? ""}/${name ?? ""})`
}

function SelectField<T extends { code?: string; title?: string }>({
  step,
  icon: Icon,
  label,
  value,
  options,
  disabled,
  loading,
  placeholder,
  onChange,
  getValue,
  getLabel
}: {
  step: number
  icon: typeof Layers3
  label: string
  value: string
  options: T[]
  disabled?: boolean
  loading?: boolean
  placeholder: string
  onChange: (value: string) => void
  getValue: (option: T) => string
  getLabel: (option: T) => string
}): React.JSX.Element {
  return (
    <label className="group grid gap-2">
      {label && (
        <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground">
            {step}
          </span>
          <Icon className="size-3.5 text-muted-foreground" />
          {label}
        </span>
      )}
      <span className="relative">
        <Select value={value} disabled={disabled || loading} onValueChange={onChange}>
          <SelectTrigger className="h-10 w-full min-w-0 overflow-hidden rounded-md border-input bg-background px-3 text-xs font-medium shadow-none transition-colors hover:border-border-emphasis focus:border-primary focus:ring-2 focus:ring-ring disabled:bg-muted/30 disabled:text-muted-foreground disabled:opacity-100 [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
            <SelectValue
              className="min-w-0 truncate"
              placeholder={loading ? "加载中..." : placeholder}
            />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => {
              const optionValue = getValue(option)
              return (
                <SelectItem key={optionValue} value={optionValue} className="text-xs">
                  <span className="block max-w-[min(70vw,28rem)] truncate" title={getLabel(option)}>
                    {getLabel(option)}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </span>
    </label>
  )
}

export function NamespaceTreeSelector({
  value,
  onChange
}: NamespaceTreeSelectorProps): React.JSX.Element {
  const [tree, setTree] = useState<NamespaceTreeNode[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [treeError, setTreeError] = useState<string | null>(null)
  const [selectedNamespace, setSelectedNamespace] = useState<NamespaceTreeNode | null>(
    value
      ? {
          pathName: value.pathName,
          pathId: value.pathId,
          devopsOrgId: value.devopsOrgId,
          namespaceId: value.namespaceId
        }
      : null
  )
  const [requirements, setRequirements] = useState<ProductRequirement[]>([])
  const [requirementCode, setRequirementCode] = useState(value?.requirement.code ?? "")
  const [details, setDetails] = useState<ImplementationDetail[]>([])
  const [selectedDetailCode, setSelectedDetailCode] = useState<string | null>(
    getDetailCode(value?.implementationDetails[0]) || null
  )
  const [loading, setLoading] = useState<"requirements" | "details" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requirementDetail, setRequirementDetail] = useState<RequirementDetail | null>(null)
  const [requirementDetailLoading, setRequirementDetailLoading] = useState(false)

  const leafNodes = useMemo(() => collectLeafNodes(tree), [tree])

  const loadTree = (): void => {
    setTreeLoading(true)
    setTreeError(null)
    void leanstarRequirementsApi
      .getNamespaceTree()
      .then((result) => {
        setTree(result.namespaceTreeList ?? [])
      })
      .catch((reason: unknown) =>
        setTreeError(reason instanceof Error ? reason.message : "加载组织命名空间树失败")
      )
      .finally(() => setTreeLoading(false))
  }

  useEffect(() => {
    let cancelled = false
    void leanstarRequirementsApi
      .getNamespaceTree()
      .then((result) => {
        if (!cancelled) setTree(result.namespaceTreeList ?? [])
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setTreeError(reason instanceof Error ? reason.message : "加载组织命名空间树失败")
        }
      })
      .finally(() => {
        if (!cancelled) setTreeLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleNamespaceChange = (key: string): void => {
    const node = leafNodes.find((item) => getNodeKey(item) === key)
    if (!node) return
    setSelectedNamespace(node)
    setRequirementCode("")
    setRequirements([])
    setDetails([])
    setSelectedDetailCode(null)
    setRequirementDetail(null)
    onChange(null)
    setLoading("requirements")
    setError(null)
    void leanstarRequirementsApi
      .listProductRequirements(node.devopsOrgId, node.namespaceType ?? "")
      .then((result) => setRequirements(result.content ?? []))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "加载需求特性失败")
      )
      .finally(() => setLoading(null))
  }

  const handleRequirementChange = (nextCode: string): void => {
    setRequirementCode(nextCode)
    setDetails([])
    setSelectedDetailCode(null)
    setRequirementDetail(null)
    onChange(null)
    if (!nextCode || !selectedNamespace) return
    const requirement = requirements.find((item) => item.code === nextCode)
    if (!requirement) return
    onChange({
      namespaceId: selectedNamespace.namespaceId || selectedNamespace.devopsOrgId,
      pathName: selectedNamespace.pathName,
      pathId: selectedNamespace.pathId,
      devopsOrgId: selectedNamespace.devopsOrgId,
      requirement,
      implementationDetails: []
    })
    // The page response may include functions for this requirement.
    setDetails(
      (requirement.functionList ?? []).map((item) => ({
        id: item.id,
        frCode: item.code,
        subFrCode: item.code,
        title: item.title,
        frStatus: item.status,
        priority: item.priority
      }))
    )
    if (requirement.functionList !== undefined) return
    setLoading("details")
    setError(null)
    void leanstarRequirementsApi
      .getImplementationDetail(nextCode)
      .then((result) => setDetails(result.subFrs ?? []))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "加载实施详情失败")
      )
      .finally(() => setLoading(null))
  }

  useEffect(() => {
    if (!selectedDetailCode || !value?.requirement.code) {
      setRequirementDetail(null)
      setRequirementDetailLoading(false)
      return
    }
    let cancelled = false
    setRequirementDetailLoading(true)
    void leanstarRequirementsApi
      .getRequirementDetail(value.requirement.code)
      .then((result) => {
        if (!cancelled) setRequirementDetail(result)
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setRequirementDetail(null)
          setError(reason instanceof Error ? reason.message : "加载需求详情失败")
        }
      })
      .finally(() => {
        if (!cancelled) setRequirementDetailLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedDetailCode, value?.requirement.code])

  const toggleDetail = (detail: ImplementationDetail): void => {
    if (!value) return
    const code = getDetailCode(detail)
    const nextCode = selectedDetailCode === code ? null : code
    setSelectedDetailCode(nextCode)
    onChange({
      ...value,
      implementationDetails: nextCode
        ? details.filter((item) => getDetailCode(item) === nextCode)
        : []
    })
  }

  return (
    <div className="mt-5">
      <div className="mb-5 flex items-center gap-0" aria-label="需求选择流程">
        {[
          { label: "命名空间", done: Boolean(selectedNamespace) },
          { label: "需求特性", done: Boolean(requirementCode) },
          { label: "实施功能", done: Boolean(selectedDetailCode) }
        ].map((item, index) => (
          <div key={item.label} className="flex min-w-0 flex-1 items-center last:flex-none">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold",
                  item.done
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-muted-foreground"
                )}
              >
                {item.done ? <Check className="size-3" /> : index + 1}
              </span>
              <span
                className={cn(
                  "truncate text-[11px] font-medium",
                  item.done ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {item.label}
              </span>
            </div>
            {index < 2 && <span className="mx-2 h-px min-w-3 flex-1 bg-border" />}
          </div>
        ))}
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        {/* 步骤 1：命名空间（组织树叶子节点，单次下拉） */}
        <label className="group grid gap-2">
          <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground">
              1
            </span>
            <Network className="size-3.5 text-muted-foreground" />
            命名空间
          </span>
          {treeLoading ? (
            <div className="flex h-10 items-center gap-2 rounded-md border border-input bg-muted/30 px-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> 加载组织树中...
            </div>
          ) : treeError ? (
            <ErrorMessage message={treeError} onRetry={loadTree} />
          ) : leafNodes.length === 0 ? (
            <p className="flex h-10 items-center rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground">
              暂无可选命名空间
            </p>
          ) : (
            <Select
              value={selectedNamespace ? getNodeKey(selectedNamespace) : ""}
              onValueChange={handleNamespaceChange}
            >
              <SelectTrigger className="h-10 w-full min-w-0 justify-start overflow-hidden rounded-md border-input bg-background px-3 text-left text-xs font-medium shadow-none transition-colors hover:border-border-emphasis focus:border-primary focus:ring-2 focus:ring-ring [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
                {selectedNamespace ? (
                  <NamespacePathLabel
                    pathName={selectedNamespace.pathName}
                    className="min-w-0 flex-1"
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    请选择命名空间
                  </span>
                )}
              </SelectTrigger>
              <SelectContent>
                {leafNodes.map((option) => {
                  const key = getNodeKey(option)
                  const disabled = option.accessible === false
                  const reasonLabel = inaccessibleLabel(option.inaccessibleReason)
                  return (
                    <SelectItem
                      key={key}
                      value={key}
                      disabled={disabled}
                      className="group text-xs data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                    >
                      <NamespacePathLabel
                        pathName={option.pathName}
                        className={cn(
                          "max-w-[min(70vw,28rem)]",
                          disabled && "text-muted-foreground/60"
                        )}
                      />
                      {reasonLabel && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          {reasonLabel}
                        </span>
                      )}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          )}
        </label>

        {/* 步骤 2：需求特性 */}
        <SelectField
          step={2}
          icon={Layers3}
          label="需求特性"
          value={requirementCode}
          options={requirements}
          disabled={!selectedNamespace}
          loading={loading === "requirements"}
          placeholder={selectedNamespace ? "请选择需求特性" : "请先选择命名空间"}
          onChange={handleRequirementChange}
          getValue={(option) => option.code}
          getLabel={(option) => {
            const owner = getOwnerLabel(option.owner)
            return `${option.title}（${option.code}）${owner}`
          }}
        />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorMessage message={error} onRetry={loadTree} />
        </div>
      )}

      {value && (
        <div className="mt-6 border-t border-border pt-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground">
                  3
                </span>
                <ClipboardList className="size-3.5 text-muted-foreground" />
                选择实施功能
              </div>
              <p className="mt-1 pl-7 text-[11px] text-muted-foreground">
                选择一项功能作为本次设计依据。
              </p>
            </div>
            {loading === "details" && (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          {loading === "details" ? (
            <div className="mt-4 flex h-10 items-center justify-center gap-2 rounded-md border border-dashed border-border text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> 加载实施功能中...
            </div>
          ) : details.length > 0 ? (
            <div className="mt-3">
              <SelectField
                step={3}
                icon={ClipboardList}
                label=""
                value={selectedDetailCode ?? ""}
                options={details}
                placeholder="请选择实施功能"
                onChange={(code) => {
                  const detail = details.find((item) => getDetailCode(item) === code)
                  if (detail) toggleDetail(detail)
                }}
                getValue={getDetailCode}
                getLabel={(detail) => `${detail.title}（${getDetailCode(detail)}）`}
              />
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              该需求特性暂无实施详情。
            </p>
          )}
          {selectedDetailCode && (
            <div className="mt-4 rounded-md border border-border bg-muted/20 p-3">
              <div className="text-xs font-semibold text-foreground">需求详情</div>
              {requirementDetailLoading ? (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" /> 加载需求详情中...
                </div>
              ) : requirementDetail ? (
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">
                  {JSON.stringify(requirementDetail, null, 2)}
                </pre>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
