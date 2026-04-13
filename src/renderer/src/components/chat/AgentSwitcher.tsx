import { useState, useEffect } from "react"
import { ChevronDown, Check, Bot } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const AVAILABLE_AGENTS = [
  { id: "", label: "DeepAgent", description: "内置 AI Agent" },
  // { id: "codex", label: "Codex", description: "OpenAI Codex" },
  // { id: "claude", label: "Claude Code", description: "Anthropic Claude" },
  { id: "devagent", label: "DevAgent", description: "自研编码助手" }
]

interface AgentSwitcherProps {
  threadId: string
  onAgentChange?: (agentId: string) => void
}

export function AgentSwitcher({ threadId, onAgentChange }: AgentSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [currentAgent, setCurrentAgent] = useState("")

  // Load agent from thread metadata on mount
  useEffect(() => {
    let cancelled = false
    window.api.threads.get(threadId).then((thread) => {
      if (cancelled) return
      const metadata = thread?.metadata || {}
      const agent = (metadata.acpxAgent as string) || ""
      setCurrentAgent(agent)
    })
    return () => { cancelled = true }
  }, [threadId])

  const handleAgentSelect = async (agentId: string): Promise<void> => {
    setCurrentAgent(agentId)
    setOpen(false)

    // Update thread metadata
    const thread = await window.api.threads.get(threadId)
    const metadata = thread?.metadata || {}
    await window.api.threads.update(threadId, {
      metadata: {
        ...metadata,
        acpxAgent: agentId || undefined
      }
    })
    onAgentChange?.(agentId)
  }

  const selected = AVAILABLE_AGENTS.find((a) => a.id === currentAgent) || AVAILABLE_AGENTS[0]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          <Bot className="size-3.5" />
          <span className="font-mono">{selected.label}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[220px] p-2 bg-background border-border"
        align="start"
        sideOffset={8}
      >
        <div className="space-y-0.5">
          {AVAILABLE_AGENTS.map((agent) => (
            <button
              key={agent.id}
              onClick={() => handleAgentSelect(agent.id)}
              className={cn(
                "w-full flex items-center gap-1.5 px-2 py-1.5 rounded-sm text-xs transition-colors text-left font-mono",
                currentAgent === agent.id
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              <Bot className="size-3.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="truncate">{agent.label}</div>
                <div className="text-[10px] text-muted-foreground/70 truncate">{agent.description}</div>
              </div>
              {currentAgent === agent.id && (
                <Check className="size-3.5 shrink-0 text-foreground" />
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
