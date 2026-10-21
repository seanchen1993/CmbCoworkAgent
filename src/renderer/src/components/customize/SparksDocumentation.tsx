import { useEffect, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { ArrowLeft, ArrowRight, ExternalLink, Search } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { SPARKS_DOCUMENTS, sparksDocumentLink, type SparksDocumentFile } from "./sparks-document-links"
import overview from "../../../../../docs/sparks/README.md?raw"
import projectPlatform from "../../../../../docs/sparks/project-platform.md?raw"
import projectCookbook from "../../../../../docs/sparks/project-plugin-cookbook.md?raw"
import create from "../../../../../docs/sparks/create.md?raw"
import ui from "../../../../../docs/sparks/interface.md?raw"
import events from "../../../../../docs/sparks/events-and-api.md?raw"
import reuse from "../../../../../docs/sparks/reuse.md?raw"
import migration from "../../../../../docs/sparks/migration.md?raw"
import cookbook from "../../../../../docs/sparks/plugin-cookbook.md?raw"
import troubleshooting from "../../../../../docs/sparks/troubleshooting.md?raw"
import reference from "../../../../../docs/sparks/reference.md?raw"
import creatorPluginWorkflow from "../../../../../docs/sparks/creator-plugin-workflow.md?raw"
import businessModAssembly from "../../../../../docs/sparks/business-mod-assembly.md?raw"
import platformAuthoringLifecycle from "../../../../../docs/sparks/platform-authoring-lifecycle.md?raw"
import stageDebugModExtension from "../../../../../docs/sparks/stage-debug-mod-extension.md?raw"
import autobizCompositionExample from "../../../../../docs/sparks/autobiz-composition-example.md?raw"
import { SparksDocumentationImage } from "./SparksDocumentationImage"

const content: Record<SparksDocumentFile, string> = {
  "README.md": overview,
  "project-platform.md": projectPlatform,
  "project-plugin-cookbook.md": projectCookbook,
  "create.md": create,
  "interface.md": ui,
  "events-and-api.md": events,
  "reuse.md": reuse,
  "migration.md": migration,
  "plugin-cookbook.md": cookbook,
  "troubleshooting.md": troubleshooting,
  "reference.md": reference,
  "creator-plugin-workflow.md": creatorPluginWorkflow,
  "business-mod-assembly.md": businessModAssembly,
  "platform-authoring-lifecycle.md": platformAuthoringLifecycle,
  "stage-debug-mod-extension.md": stageDebugModExtension,
  "autobiz-composition-example.md": autobizCompositionExample
}

export default function SparksDocumentation({ onClose, initialFile = "README.md" }: {
  onClose: () => void; initialFile?: SparksDocumentFile
}) {
  const [file, setFile] = useState<SparksDocumentFile>(initialFile)
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const article = useRef<HTMLElement>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    article.current?.scrollTo({ top: 0 })
  }, [file])
  const current = SPARKS_DOCUMENTS.findIndex((item) => item.file === file)
  const search = query.trim().toLocaleLowerCase()
  const matches = SPARKS_DOCUMENTS.filter((item) =>
    `${item.title}\n${content[item.file]}`.toLocaleLowerCase().includes(search)
  )
  const navigate = (next: SparksDocumentFile) => {
    setFile(next)
    setError("")
  }
  const openExternal = async (url: string) => {
    setError("")
    try {
      await window.electron.openExternal(url)
    } catch {
      if (alive.current) setError("无法打开外部参考链接，请稍后重试。离线说明仍可阅读。")
    }
  }
  return (
    <Dialog open onOpenChange={(value) => { if (!value) onClose() }}>
      <DialogContent className="flex h-[min(88vh,900px)] w-[calc(100vw-2rem)] max-w-6xl flex-col gap-3 p-4 sm:p-6">
        <DialogHeader className="shrink-0 pr-7">
          <DialogTitle>DevClaw Sparks 官方说明</DialogTitle>
          <DialogDescription>灵件、插件与项目流程的使用步骤、操作示例和开发参考。</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
          <nav aria-label="说明章节" className="shrink-0 md:w-48 md:overflow-y-auto">
            <label className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <input
                aria-label="搜索说明章节"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索说明"
                className="min-w-0 w-full bg-transparent text-sm outline-none"
              />
            </label>
            <div className="grid max-h-32 grid-cols-2 gap-1 overflow-y-auto md:max-h-none md:grid-cols-1">
              {matches.map((item) => (
                <button
                  key={item.file}
                  type="button"
                  aria-current={item.file === file ? "page" : undefined}
                  onClick={() => navigate(item.file)}
                  className={`rounded-md px-3 py-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${item.file === file ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted"}`}
                >{item.title}</button>
              ))}
            </div>
            {search && <p role="status" className="mt-2 text-xs text-muted-foreground">找到 {matches.length} 个章节</p>}
          </nav>
          <article
            ref={article}
            aria-label="说明正文"
            tabIndex={0}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border bg-background p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6"
          >
            <div className="mx-auto max-w-3xl break-words text-sm leading-7 text-foreground">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                skipHtml
                components={{
                  h1: ({ children }) => <h1 className="mb-5 text-2xl font-semibold leading-tight tracking-tight">{children}</h1>,
                  h2: ({ children }) => <h2 className="mb-3 mt-8 text-lg font-semibold leading-snug">{children}</h2>,
                  h3: ({ children }) => <h3 className="mb-2 mt-6 text-base font-semibold">{children}</h3>,
                  p: ({ children }) => <p className="my-3 leading-7">{children}</p>,
                  ul: ({ children }) => <ul className="my-4 list-disc space-y-2 pl-6">{children}</ul>,
                  ol: ({ children }) => <ol className="my-4 list-decimal space-y-2 pl-6">{children}</ol>,
                  blockquote: ({ children }) => <blockquote className="my-4 rounded-r-md border-l-4 border-primary/40 bg-muted/40 px-4 py-1 text-muted-foreground">{children}</blockquote>,
                  pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-lg border bg-muted/40 p-4 text-xs leading-6 [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
                  code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
                  a: ({ href = "", children }) => {
                    const target = sparksDocumentLink(href)
                    if (target.kind === "reference")
                      return <span title={href} className="text-muted-foreground">{children}<small>（仓库参考）</small></span>
                    return (
                      <a
                        href={href}
                        className="text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary"
                        title={target.kind === "external" ? "在外部浏览器打开" : undefined}
                        onClick={(event) => {
                          event.preventDefault()
                          if (target.kind === "chapter") navigate(target.file)
                          else void openExternal(target.url)
                        }}
                      >
                        {children}
                        {target.kind === "external" && <ExternalLink className="ml-1 inline size-3" aria-hidden="true" />}
                      </a>
                    )
                  },
                  table: ({ children }) => <div className="my-5 overflow-x-auto rounded-lg border"><table className="w-full border-collapse text-left text-sm leading-6">{children}</table></div>,
                  thead: ({ children }) => <thead className="bg-muted/60">{children}</thead>,
                  th: ({ children }) => <th className="border-b px-3 py-2.5 align-top font-semibold">{children}</th>,
                  td: ({ children }) => <td className="border-b px-3 py-2.5 align-top">{children}</td>,
                  img: ({ src, alt, title }) => (
                    <SparksDocumentationImage key={src} src={src} alt={alt} title={title} />
                  )
                }}
              >{content[file]}</ReactMarkdown>
            </div>
          </article>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t pt-3">
          <Button variant="outline" size="sm" disabled={current === 0} onClick={() => navigate(SPARKS_DOCUMENTS[current - 1].file)}>
            <ArrowLeft className="mr-1 size-4" aria-hidden="true" />上一章
          </Button>
          <span className="text-xs text-muted-foreground">{current + 1} / {SPARKS_DOCUMENTS.length}</span>
          <Button variant="outline" size="sm" disabled={current === SPARKS_DOCUMENTS.length - 1} onClick={() => navigate(SPARKS_DOCUMENTS[current + 1].file)}>
            下一章<ArrowRight className="ml-1 size-4" aria-hidden="true" />
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
