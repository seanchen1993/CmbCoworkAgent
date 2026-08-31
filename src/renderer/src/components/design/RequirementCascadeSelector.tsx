import { useEffect, useState } from "react"
import {
  Check,
  CheckCircle2,
  Circle,
  ClipboardList,
  Layers3,
  LoaderCircle,
  Package,
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
  type DigitalProduct,
  type ImplementationDetail,
  type ProductRequirement
} from "@/api/leanstar-requirements"

export type RequirementCascadeSelection = {
  product: DigitalProduct
  requirement: ProductRequirement
  implementationDetails: ImplementationDetail[]
}

type RequirementCascadeSelectorProps = {
  value: RequirementCascadeSelection | null
  onChange: (selection: RequirementCascadeSelection | null) => void
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

function SelectField<T extends { id?: string; name?: string; code?: string; title?: string }>({
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
  icon: typeof Package
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
      <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-bold text-muted-foreground group-focus-within:bg-primary group-focus-within:text-primary-foreground">
          {step}
        </span>
        <Icon className="size-3.5 text-muted-foreground" />
        {label}
      </span>
      <span className="relative">
        <Select value={value} disabled={disabled || loading} onValueChange={onChange}>
          <SelectTrigger className="h-10 w-full rounded-md border-input bg-background px-3 text-xs font-medium shadow-none transition-colors hover:border-border-emphasis focus:border-primary focus:ring-2 focus:ring-ring disabled:bg-muted/30 disabled:text-muted-foreground disabled:opacity-100 [&>svg]:size-3.5 [&>svg]:text-muted-foreground">
            <SelectValue placeholder={loading ? "加载中..." : placeholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => {
              const optionValue = getValue(option)
              return (
                <SelectItem key={optionValue} value={optionValue} className="text-xs">
                  {getLabel(option)}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </span>
    </label>
  )
}

export function RequirementCascadeSelector({
  value,
  onChange
}: RequirementCascadeSelectorProps): React.JSX.Element {
  const [products, setProducts] = useState<DigitalProduct[]>([])
  const [requirements, setRequirements] = useState<ProductRequirement[]>([])
  const [details, setDetails] = useState<ImplementationDetail[]>([])
  const [selectedDetailCode, setSelectedDetailCode] = useState<string | null>(
    value?.implementationDetails[0]?.code ?? null
  )
  const [productId, setProductId] = useState(value?.product.id ?? "")
  const [requirementCode, setRequirementCode] = useState(value?.requirement.code ?? "")
  const [loading, setLoading] = useState<"products" | "requirements" | "details" | null>("products")
  const [error, setError] = useState<string | null>(null)

  const loadProducts = (): void => {
    setLoading("products")
    setError(null)
    void leanstarRequirementsApi
      .listDigitalProducts()
      .then((result) => setProducts(result.content ?? []))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "加载数字产品失败")
      )
      .finally(() => setLoading(null))
  }

  useEffect(() => {
    let cancelled = false
    void leanstarRequirementsApi
      .listDigitalProducts()
      .then((result) => {
        if (!cancelled) setProducts(result.content ?? [])
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "加载数字产品失败")
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleProductChange = (nextProductId: string): void => {
    setProductId(nextProductId)
    setRequirementCode("")
    setRequirements([])
    setDetails([])
    setSelectedDetailCode(null)
    onChange(null)
    if (!nextProductId) return
    setLoading("requirements")
    setError(null)
    void leanstarRequirementsApi
      .listProductRequirements(nextProductId)
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
    onChange(null)
    if (!nextCode) return
    const requirement = requirements.find((item) => item.code === nextCode)
    const product = products.find((item) => item.id === productId)
    if (!requirement || !product) return
    onChange({ product, requirement, implementationDetails: [] })
    setLoading("details")
    setError(null)
    void leanstarRequirementsApi
      .getImplementationDetail(nextCode)
      .then((result) => {
        setDetails(result.subFrs ?? [])
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "加载实施详情失败")
      )
      .finally(() => setLoading(null))
  }

  const toggleDetail = (detail: ImplementationDetail): void => {
    if (!value) return
    const nextCode = selectedDetailCode === detail.code ? null : detail.code
    setSelectedDetailCode(nextCode)
    onChange({
      ...value,
      implementationDetails: nextCode ? details.filter((item) => item.code === nextCode) : []
    })
  }

  return (
    <div className="mt-5">
      <div className="mb-5 flex items-center gap-0" aria-label="需求选择流程">
        {[
          { label: "数字产品", done: Boolean(productId) },
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
        <SelectField
          step={1}
          icon={Package}
          label="数字产品"
          value={productId}
          options={products}
          loading={loading === "products"}
          placeholder="请选择数字产品"
          onChange={handleProductChange}
          getValue={(option) => option.id}
          getLabel={(option) => option.name}
        />
        <SelectField
          step={2}
          icon={Layers3}
          label="需求特性"
          value={requirementCode}
          options={requirements}
          disabled={!productId}
          loading={loading === "requirements"}
          placeholder={productId ? "请选择需求特性" : "请先选择数字产品"}
          onChange={handleRequirementChange}
          getValue={(option) => option.code}
          getLabel={(option) => `${option.title}（${option.code}）`}
        />
      </div>

      {error && (
        <div className="mt-4">
          <ErrorMessage message={error} onRetry={loadProducts} />
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
            <div className="mt-4 flex h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-border text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> 加载实施详情中...
            </div>
          ) : details.length > 0 ? (
            <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
              {details.map((detail) => (
                <button
                  type="button"
                  key={detail.code}
                  aria-pressed={selectedDetailCode === detail.code}
                  onClick={() => toggleDetail(detail)}
                  className={cn(
                    "flex min-h-14 w-full items-center gap-3 border-b border-border px-3.5 py-3 text-left transition-colors last:border-b-0 focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selectedDetailCode === detail.code
                      ? "bg-primary/5"
                      : "bg-background hover:bg-muted/30"
                  )}
                >
                  <span className="shrink-0 text-primary">
                    {selectedDetailCode === detail.code ? (
                      <CheckCircle2 className="size-[18px]" />
                    ) : (
                      <Circle className="size-[18px] text-muted-foreground/70" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-foreground">
                      {detail.title}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {detail.code}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              该需求特性暂无实施详情。
            </p>
          )}
        </div>
      )}
    </div>
  )
}
