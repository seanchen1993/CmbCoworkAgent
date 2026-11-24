import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useId, useRef, memo } from "react"
import { createPortal, flushSync } from "react-dom"
import {
  GitBranch,
  Check,
  Loader2,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  GitGraph,
  Search,
  X,
  Plus
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { GitGraphDialog } from "@/components/git/GitGraphDialog"
import { mapScrollPosition, maxScrollHeight } from "@/components/git/git-graph-layout"
import { DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { observeWorkbenchDialogOpen } from "@/lib/modal-dialog"
import { cn } from "@/lib/utils"
import { retainListFocus } from "@/lib/virtual-row-focus"
import { beginGitCheckout, worktreeRootKey } from "@/lib/pending-git-checkouts"
import { toast } from "sonner"
import { isSameGitWorkspacePath } from "../../../../shared/workspace-path"
import {
  GIT_BRANCH_REFRESH_EVENT,
  trimGitBranchInput,
  type GitBranchChoice,
  type GitBranchMenuPage,
  type GitBranchSwitched
} from "../../../../shared/git-branches"

interface GitBranchSwitcherProps {
  /** 工作区路径，用于执行 git 命令的 cwd */
  workspacePath?: string | null
  environmentRailCollapsed: boolean
}

type GitBranchRepositoryInfo = {
  path: string
  displayPath: string
  gitRoot: string
  branch?: string | null
  isWorktree?: boolean
  isInsideWorkTree?: boolean
  gitDir?: string
  error?: string
}

const branchRowHeight = 36
const branchHeaderHeight = 26
const branchListHeight = 192
const branchOverscanRows = 4
const dirtyRowExtra = 18
const branchWorkBudgetMs = 4
const largeBranchListCharacters = 256 * 1024
const branchKinds = ["local", "remote"] as const
const menuActionClass =
  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
type BranchLists = Record<GitBranchChoice["kind"], string[]>
type BranchSnapshot = BranchLists & { searchNames?: BranchLists }
type SearchKey = "ArrowDown" | "Enter"
const emptyBranchLists: BranchSnapshot = { local: [], remote: [] }

function nextBranchWorkSlice(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function parseBranchLists(
  payload: GitBranchMenuPage,
  isCurrent: () => boolean
): Promise<BranchSnapshot | undefined> {
  if (!payload.next && payload.local.length + payload.remote.length <= largeBranchListCharacters) {
    return {
      local: payload.local ? payload.local.split("\n") : [],
      remote: payload.remote ? payload.remote.split("\n") : []
    }
  }

  const searchNames: BranchLists = { local: [], remote: [] }
  const branches: BranchSnapshot = { local: [], remote: [], searchNames }
  let page = payload
  while (isCurrent()) {
    let deadline = performance.now() + branchWorkBudgetMs
    for (const kind of branchKinds) {
      const text = page[kind]
      for (let start = 0; start < text.length; ) {
        const newline = text.indexOf("\n", start)
        const end = newline < 0 ? text.length : newline
        const name = text.slice(start, end)
        const lower = name.toLowerCase()
        branches[kind].push(name)
        searchNames[kind].push(lower === name ? name : lower)
        start = end + 1
        if (branches[kind].length % 256 === 0 && performance.now() >= deadline) {
          await nextBranchWorkSlice()
          if (!isCurrent()) return
          deadline = performance.now() + branchWorkBudgetMs
        }
      }
    }
    if (!page.next) return branches
    page = await window.api.git.readBranchMenuPage(page.next)
  }
  return undefined
}

async function searchBranchLists(
  branches: BranchLists,
  searchNames: BranchLists,
  query: string,
  isCurrent: () => boolean
): Promise<BranchLists | undefined> {
  const matches: BranchLists = { local: [], remote: [] }
  let deadline = performance.now() + branchWorkBudgetMs
  for (const kind of branchKinds) {
    const names = searchNames[kind]
    for (let index = 0; index < names.length; index++) {
      if (names[index].includes(query)) matches[kind].push(branches[kind][index])
      if (index % 256 === 0 && performance.now() >= deadline) {
        await nextBranchWorkSlice()
        if (!isCurrent()) return
        deadline = performance.now() + branchWorkBudgetMs
      }
    }
  }
  return matches
}

function notifyGitBranchSwitched(detail: GitBranchSwitched): void {
  window.dispatchEvent(
    new CustomEvent(GIT_BRANCH_REFRESH_EVENT, {
      detail
    })
  )
}

function BranchMenu({
  id,
  anchorName,
  menuRef,
  triggerRef,
  onBeforeToggle,
  onOpen,
  onDismiss,
  children
}: React.PropsWithChildren<{
  id: string
  anchorName: string
  menuRef: React.RefObject<HTMLDivElement | null>
  triggerRef: React.RefObject<HTMLButtonElement | null>
  onBeforeToggle: (open: boolean) => void
  onOpen: () => void
  onDismiss: () => void
}>): React.JSX.Element {
  const handleEscape = useCallback((event: KeyboardEvent): void => {
    if (event.key !== "Escape" || event.defaultPrevented || !menuRef.current?.matches(":popover-open")) return
    // A click inside the menu or a disabled button can leave focus on the document.
    event.preventDefault()
    if (event.isComposing) return
    const restoreTrigger = document.activeElement === document.body
    onDismiss()
    if (restoreTrigger) triggerRef.current?.focus({ preventScroll: true })
  }, [menuRef, onDismiss, triggerRef])

  useEffect(() => {
    if (menuRef.current?.matches(":popover-open")) window.addEventListener("keydown", handleEscape, true)
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [handleEscape, menuRef])

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      role="dialog"
      aria-label="切换 Git 分支"
      data-slot="popover-content"
      popover="auto"
      onBeforeToggle={(event) => {
        const opening = event.newState === "open"
        if (opening) window.addEventListener("keydown", handleEscape, true)
        else window.removeEventListener("keydown", handleEscape, true)
        onBeforeToggle(opening)
      }}
      onToggle={(event) => {
        if (event.newState === "open") onOpen()
      }}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next && !event.currentTarget.contains(next) && next !== triggerRef.current) {
          onDismiss()
        }
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return
        const stops = event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']"
        )
        const first = stops[0]
        const last = stops[stops.length - 1]
        if (!first || document.activeElement !== (event.shiftKey ? first : last)) return
        event.preventDefault()
        const next = event.shiftKey ? last : first
        next.focus({ preventScroll: true })
      }}
      className="git-branch-menu z-50 rounded-xl border bg-popover p-0 text-popover-foreground shadow-md outline-none [-webkit-app-region:no-drag]"
      style={{ positionAnchor: anchorName }}
    >
      {children}
    </div>,
    document.body
  )
}

export const GitBranchSwitcher = memo(GitBranchSwitcherImpl)

function GitBranchSwitcherImpl({
  workspacePath,
  environmentRailCollapsed
}: GitBranchSwitcherProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [gitRepoChecked, setGitRepoChecked] = useState(false)
  const [probeRevision, setProbeRevision] = useState(0)
  const [isGitRepo, setIsGitRepo] = useState(false)
  const [isMultiRepo, setIsMultiRepo] = useState(false)
  const [repositories, setRepositories] = useState<GitBranchRepositoryInfo[]>([])
  const [selectedRepositoryPath, setSelectedPath] = useState<string | null>(null)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [isWorktree, setIsWorktree] = useState(false)
  const [isInsideWorkTree, setIsInsideWorkTree] = useState<boolean>()
  const [gitDir, setGitDir] = useState<string>()
  const [gitRoot, setGitRoot] = useState<string>()
  const [gitStatusError, setGitStatusError] = useState<string | null>(null)
  const [branches, setBranches] = useState(emptyBranchLists)
  const [branchSearch, setBranchSearch] = useState<{
    branches: BranchSnapshot
    query: string
    matches: BranchLists
  }>()
  const [dirtyStatus, setDirtyStatus] = useState<{ branch: string; count: number } | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [branchScrollTop, setBranchScrollTop] = useState(0)
  const [newBranchName, setNewBranchName] = useState<string | null>(null)
  const [graphOpen, setGraphOpen] = useState(false)
  const [switchingRoots, setSwitchingRoots] = useState<ReadonlySet<string>>(() => new Set())
  const [actionError, setActionError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [branchListStatus, setBranchListStatus] = useState<"idle" | "loading" | "ready">("idle")
  const [branchListRevision, setBranchListRevision] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const newBranchInputRef = useRef<HTMLInputElement>(null)
  const branchListRef = useRef<HTMLDivElement>(null)
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuOpen = useRef(false)
  const menuOpensDialog = useRef(false)
  const branchListRequest = useRef(0)
  const queuedSearchKey = useRef<{ key: SearchKey; value: string } | undefined>(undefined)
  const branchHeadRevision = useRef(0)
  const pendingBranchHead = useRef<string | undefined>(undefined)
  const observedHead = useRef<Omit<GitBranchSwitched, "branch"> & { branch?: string | null }>(undefined)
  const localHeadEvent = useRef<GitBranchSwitched>(undefined)
  const mutationHeadsDuringProbe = useRef<Map<string, string | null> | null>(null)
  const unverifiedBranchChanges = useRef(new Map<string, string | null>())
  const repositoryReads = useRef(new Map<string, ReturnType<typeof window.api.git.currentBranch>>())
  const pendingMutations = useRef(new Map<string, symbol>())
  const selectedRepositoryPathRef = useRef<string | null>(null)
  const createDialogOpen = useRef(false)
  const newBranchNameId = useId()
  const newBranchDialogRef = useRef<HTMLDialogElement>(null)
  const creatingBranch = newBranchName !== null
  const branchMenuId = useId()
  const branchLabelId = `${branchMenuId}-current`
  const branchAnchorName = `--git-branch-${branchMenuId}`

  const setSelectedRepositoryPath = useCallback((path: string | null): void => {
    selectedRepositoryPathRef.current = path
    setSelectedPath(path)
  }, [])

  const closeCreateDialog = useCallback((): void => {
    createDialogOpen.current = false
    // Let Chromium restore focus while the input is still mounted.
    newBranchDialogRef.current?.close()
    setNewBranchName(null)
  }, [])

  useLayoutEffect(() => {
    const dialog = newBranchDialogRef.current
    if (!creatingBranch || !dialog) return
    const input = newBranchInputRef.current
    if (input) input.autofocus = true
    dialog.showModal()
    // A workbench dialog can open asynchronously while Git is still running.
    const unsubscribe = observeWorkbenchDialogOpen((incoming) => {
      closeCreateDialog()
      if (!incoming.contains(document.activeElement)) incoming.focus({ preventScroll: true })
    })
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!dialog.open || event.defaultPrevented) return
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.isComposing) closeCreateDialog()
      } else if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Chromium can move focus out of the renderer at either end of a modal dialog.
        const last = dialog.querySelector<HTMLButtonElement>(":scope > button")
        const active = document.activeElement
        if (active === dialog || active === (event.shiftKey ? input : last) || !dialog.contains(active)) {
          event.preventDefault()
          const next = event.shiftKey ? last : input
          next?.focus({ preventScroll: true })
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true)
      unsubscribe()
      dialog.close()
    }
  }, [creatingBranch, closeCreateDialog])

  const handleMenuClosed = useCallback((): void => {
    if (!menuOpen.current) return
    menuOpen.current = false
    queuedSearchKey.current = undefined
    branchListRequest.current++
    setOpen(false)
    setSearchQuery("")
    setBranchScrollTop(0)
    setActionError(null)
    setBranchSearch(undefined)
    setBranchListStatus("idle")
    void window.api.git.cancelBranchList().catch(() => undefined)
  }, [])

  const handleMenuBeforeToggle = useCallback((next: boolean): void => {
    if (next) {
      menuOpensDialog.current = false
      menuOpen.current = true
    } else {
      if (!menuOpensDialog.current && branchMenuRef.current?.contains(document.activeElement)) {
        triggerRef.current?.focus({ preventScroll: true })
      }
      handleMenuClosed()
    }
  }, [handleMenuClosed])

  const handleMenuOpened = useCallback((): void => {
    if (!menuOpen.current) return
    setOpen(true)
    setBranchListStatus("loading")
  }, [])

  const closeMenu = useCallback((): void => {
    const menu = branchMenuRef.current
    if (menu?.matches(":popover-open")) {
      const focused = document.activeElement
      if (menuOpensDialog.current && focused instanceof HTMLElement && menu.contains(focused)) {
        focused.blur()
      }
      menu.hidePopover()
    }
    handleMenuClosed()
  }, [handleMenuClosed])

  const setSearchInput = useCallback((input: HTMLInputElement | null): void => {
    searchInputRef.current = input
    if (input) input.autofocus = true
  }, [])

  useEffect(() => {
    let cancelled = false
    const mutationHeads = new Map<string, string | null>()
    mutationHeadsDuringProbe.current = mutationHeads
    unverifiedBranchChanges.current.clear()
    setGitRepoChecked(false)
    closeMenu()
    setGraphOpen(false)
    closeCreateDialog()
    setSwitchingRoots(new Set())
    setRepositories([])
    setSelectedRepositoryPath(null)
    setGitDir(undefined)
    setGitRoot(undefined)
    setBranches(emptyBranchLists)
    setDirtyStatus(null)
    setListError(null)
    setActionError(null)

    async function detectBranch(): Promise<void> {
      try {
        if (!workspacePath) {
          setIsGitRepo(false)
          setGitStatusError(null)
          return
        }
        const result = await window.api.git.currentBranch(workspacePath, true)
        if (cancelled) return
        const nextRepositories = result.isMultiRepo ? (result.repositories ?? []) : []
        setIsGitRepo(result.isGitRepo)
        setGitStatusError(result.error ?? null)
        setIsMultiRepo(Boolean(result.isMultiRepo))
        setRepositories(
          nextRepositories.map((repo) => {
            const branch = mutationHeads.get(repo.path)
            return branch === undefined ? repo : { ...repo, branch }
          })
        )
        setSelectedRepositoryPath(nextRepositories[0]?.path ?? null)
        const branch = mutationHeads.get(workspacePath)
        setCurrentBranch(branch === undefined ? result.branch : branch)
        setIsWorktree(result.isWorktree)
        setIsInsideWorkTree(result.isInsideWorkTree)
        setGitDir(result.gitDir)
        setGitRoot(result.gitRoot)
      } catch (error) {
        if (cancelled) return
        setIsGitRepo(false)
        setGitStatusError(error instanceof Error ? error.message : "读取分支失败")
      } finally {
        if (!cancelled) {
          mutationHeadsDuringProbe.current = null
          setGitRepoChecked(true)
        }
      }
    }
    void detectBranch()
    return () => {
      cancelled = true
      mutationHeadsDuringProbe.current = null
      branchListRequest.current++
      void window.api.git.cancelBranchProbe().catch(() => undefined)
      if (menuOpen.current) void window.api.git.cancelBranchList().catch(() => undefined)
      menuOpen.current = false
      repositoryReads.current = new Map()
      pendingMutations.current.clear()
    }
  }, [closeCreateDialog, closeMenu, probeRevision, setSelectedRepositoryPath, workspacePath])

  const selectedRepository =
    repositories.find((repo) => repo.path === selectedRepositoryPath) ?? null
  const knownBranch = isMultiRepo ? selectedRepository?.branch : currentBranch
  const activeBranch = knownBranch ?? null
  const activeRepositoryIsWorktree = isMultiRepo
    ? Boolean(selectedRepository?.isWorktree)
    : isWorktree
  const activeRepositoryInsideWorkTree = isMultiRepo
    ? selectedRepository?.isInsideWorkTree
    : isInsideWorkTree
  const targetCwd = (isMultiRepo ? selectedRepositoryPath : workspacePath) ?? undefined
  const targetGitDir = isMultiRepo ? selectedRepository?.gitDir : gitDir
  const targetGitRoot = isMultiRepo ? selectedRepository?.gitRoot : gitRoot
  const worktreeRoot = targetGitRoot ?? targetCwd
  const targetRoot = worktreeRoot ? worktreeRootKey(worktreeRoot) : undefined
  const switching = targetRoot !== undefined && switchingRoots.has(targetRoot)
  const repositoryError = isMultiRepo ? selectedRepository?.error : gitStatusError
  const repositoryNeedsProbe = isMultiRepo && selectedRepository?.isWorktree === undefined
  const shouldProbeRepository = repositoryNeedsProbe && (open || !repositoryError)
  const canReadRepository = Boolean(targetCwd && isGitRepo)
  const canChangeBranch =
    canReadRepository &&
    activeRepositoryInsideWorkTree === true &&
    !repositoryError &&
    !activeRepositoryIsWorktree
  const canReadStatus = activeRepositoryInsideWorkTree !== false

  useLayoutEffect(() => {
    observedHead.current = gitRepoChecked && workspacePath && targetCwd
      ? { workspacePath, repositoryPath: targetCwd, gitDir: targetGitDir, gitRoot: targetGitRoot, branch: knownBranch }
      : undefined
    return () => { observedHead.current = undefined }
  }, [gitRepoChecked, knownBranch, targetCwd, targetGitDir, targetGitRoot, workspacePath])

  useEffect(() => {
    const applyBranchChange = (repositoryPath: string, branch: string | null): void => {
      mutationHeadsDuringProbe.current?.set(repositoryPath, branch)
      if (repositoryPath === workspacePath) {
        setCurrentBranch(branch)
      } else {
        setRepositories((previous) =>
          previous.map((repo) => (repo.path === repositoryPath ? { ...repo, branch } : repo))
        )
      }
      if (repositoryPath === targetCwd) {
        const head = observedHead.current
        if (head?.repositoryPath === repositoryPath && head.workspacePath === workspacePath) head.branch = branch
        branchHeadRevision.current++
        branchListRequest.current++
        setDirtyStatus(null)
        if (menuOpen.current) {
          setBranchListStatus("loading")
          setBranchListRevision((revision) => revision + 1)
        }
      }
    }

    const unverified = unverifiedBranchChanges.current
    if (targetGitDir && targetCwd) {
      const branch = unverified.get(targetGitDir)
      unverified.clear()
      if (branch !== undefined) applyBranchChange(targetCwd, branch)
    }

    const handleBranchSwitched = (event: Event): void => {
      const detail = (event as CustomEvent<GitBranchSwitched>).detail
      if (!detail || detail === localHeadEvent.current) return
      // The probe may already have read HEAD before it publishes the worktree identity.
      if (!targetGitDir && detail.gitDir) unverified.set(detail.gitDir, detail.branch)
      const sameWorktree = targetGitDir !== undefined && detail.gitDir === targetGitDir
      if (detail.workspacePath !== workspacePath && !sameWorktree) return
      const repositoryPath = sameWorktree && targetCwd ? targetCwd : detail.repositoryPath
      if (repositoryPath === targetCwd && targetGitDir && detail.gitDir && !sameWorktree) return
      applyBranchChange(repositoryPath, detail.branch)
    }
    window.addEventListener(GIT_BRANCH_REFRESH_EVENT, handleBranchSwitched)
    return () => window.removeEventListener(GIT_BRANCH_REFRESH_EVENT, handleBranchSwitched)
  }, [targetCwd, targetGitDir, workspacePath])

  useEffect(() => {
    if (!selectedRepositoryPath) return
    const requests = repositoryReads.current
    return () => {
      if (requests.delete(selectedRepositoryPath)) {
        void window.api.git.cancelBranchProbe().catch(() => undefined)
      }
    }
  }, [selectedRepositoryPath])

  useEffect(() => {
    if (!gitRepoChecked || !shouldProbeRepository || !selectedRepositoryPath) return
    let cancelled = false
    const cwd = selectedRepositoryPath
    const requests = repositoryReads.current
    let request = requests.get(cwd)
    if (!request) {
      request = window.api.git.currentBranch(cwd, true).finally(() => {
        if (requests.get(cwd) === request) requests.delete(cwd)
      })
      requests.set(cwd, request)
    }

    // 只探测选中的仓库。下次打开菜单或选中该仓库时可以重试。
    function applyRepositoryStatus(
      status: Pick<
        GitBranchRepositoryInfo,
        "branch" | "isWorktree" | "isInsideWorkTree" | "gitDir" | "error"
      >
    ): void {
      if (cancelled) return
      setRepositories((previous) =>
        previous.map((repo) =>
          repo.path === cwd
            ? {
                ...repo,
                ...status,
                branch: repo.branch !== undefined ? repo.branch : status.branch
              }
            : repo
        )
      )
    }

    void request.then(
      (result) => {
        const error =
          result.error ?? (!result.isGitRepo || result.isMultiRepo ? "无法读取此仓库" : undefined)
        applyRepositoryStatus({
          branch: error ? undefined : result.branch,
          isWorktree: error ? undefined : result.isWorktree,
          isInsideWorkTree: error ? undefined : result.isInsideWorkTree,
          gitDir: error ? undefined : result.gitDir,
          error
        })
      },
      (error: unknown) =>
        applyRepositoryStatus({ error: error instanceof Error ? error.message : "读取分支失败" })
    )
    return () => {
      cancelled = true
    }
  }, [gitRepoChecked, selectedRepositoryPath, shouldProbeRepository])

  const updateHead = useCallback(
    (cwd: string, branch: string | null): void => {
      if (isMultiRepo) {
        setRepositories((prev) =>
          prev.map((repo) => (repo.path === cwd ? { ...repo, branch } : repo))
        )
      } else {
        setCurrentBranch(branch)
      }
    },
    [isMultiRepo]
  )

  const acceptObservedHead = useCallback((branch: string | null): void => {
    const head = observedHead.current
    if (!workspacePath || !targetCwd || head?.workspacePath !== workspacePath || head.repositoryPath !== targetCwd) return
    const previousBranch = head.branch
    if (previousBranch === branch) return
    head.branch = branch
    updateHead(targetCwd, branch)
    if (previousBranch === undefined) return

    // The branch list or no-op switch confirmed a different HEAD. Refresh other
    // views without discarding the verified branch list in this menu.
    const detail = { ...head, branch }
    localHeadEvent.current = detail
    try {
      notifyGitBranchSwitched(detail)
    } finally {
      localHeadEvent.current = undefined
    }
  }, [targetCwd, updateHead, workspacePath])

  useEffect(() => {
    if (!gitRepoChecked || !workspacePath || !targetCwd || !targetGitDir || !targetRoot) return
    const workspace = workspacePath
    const cwd = targetCwd
    const gitDirectory = targetGitDir
    const root = targetRoot
    let disposed = false
    let reading = false
    let revision = 0

    async function refreshBranchHead(): Promise<void> {
      if (menuOpen.current || pendingMutations.current.has(root)) return
      const request = ++revision
      if (reading) return
      reading = true
      const knownHead = branchHeadRevision.current
      try {
        const branch = await window.api.git.readBranchHead(gitDirectory)
        const head = observedHead.current
        if (
          branch !== undefined && head?.repositoryPath === cwd && head.workspacePath === workspace && branch !== head.branch &&
          !disposed &&
          request === revision &&
          knownHead === branchHeadRevision.current &&
          !menuOpen.current &&
          !pendingMutations.current.has(root)
        ) {
          notifyGitBranchSwitched({
            workspacePath: workspace,
            repositoryPath: cwd,
            gitDir: gitDirectory,
            gitRoot: targetGitRoot,
            branch
          })
        }
      } catch {
        // Keep the last verified branch until another change or the next menu read.
      } finally {
        reading = false
        if (!disposed && request !== revision) void refreshBranchHead()
      }
    }

    function requestBranchHead(): void {
      if (menuOpen.current || pendingMutations.current.has(root)) {
        pendingBranchHead.current = gitDirectory
        return
      }
      void refreshBranchHead()
    }
    const unsubscribe = window.api.workspace.onFilesChanged((event) => {
      const changedPath = event.literalWorkspacePath ?? event.workspacePath
      if (
        event.changeType === "meta" &&
        (isSameGitWorkspacePath(changedPath, workspacePath) ||
          isSameGitWorkspacePath(changedPath, targetGitRoot))
      ) {
        requestBranchHead()
      }
    })
    window.addEventListener("focus", requestBranchHead)
    if (!open && !switching) {
      const shouldRefresh = pendingBranchHead.current === gitDirectory
      pendingBranchHead.current = undefined
      if (shouldRefresh) requestBranchHead()
    }
    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener("focus", requestBranchHead)
      if (reading) {
        if (menuOpen.current || pendingMutations.current.has(root)) pendingBranchHead.current = gitDirectory
        void window.api.git.cancelBranchHead().catch(() => undefined)
      }
    }
  }, [activeBranch, gitRepoChecked, open, switching, targetCwd, targetGitDir, targetGitRoot, targetRoot, workspacePath])

  const loadBranches = useCallback(
    async (refreshRemote = false) => {
      if (!menuOpen.current || !targetCwd || !canReadRepository) return
      const request = ++branchListRequest.current
      const isCurrent = () => request === branchListRequest.current &&
        observedHead.current?.repositoryPath === targetCwd && observedHead.current.workspacePath === workspacePath
      setBranchListStatus("loading")
      setListError(null)
      let branch: string | null | undefined
      let fresh = false
      try {
        const result = await window.api.git.listBranchMenu(targetCwd, { refreshRemote, paged: true })
        if (!isCurrent()) return
        const nextBranches = await parseBranchLists(result, isCurrent)
        if (!nextBranches || !isCurrent()) return
        setBranches(nextBranches)
        branch = result.branch
        // An origin fetch can fail even when the repository's current refs were read.
        fresh = result.success || branch !== undefined
        if (branch !== undefined) acceptObservedHead(branch)
        if (!result.success) {
          setListError(result.error || "刷新分支列表失败")
        }
      } catch {
        if (!isCurrent()) return
        setListError("刷新分支列表失败")
      } finally {
        if (isCurrent()) {
          if (!fresh && queuedSearchKey.current?.key === "Enter") queuedSearchKey.current = undefined
          setBranchListStatus(fresh ? "ready" : "idle")
        }
      }

      // 状态扫描可能较慢，让分支列表先显示，并将文件数关联到本次读取的分支。
      if (!branch || !canReadStatus || !isCurrent()) return
      try {
        const count = await window.api.git.getChangedFileCount(targetCwd, branch)
        if (isCurrent()) setDirtyStatus({ branch, count })
      } catch {
        // 分支列表与状态扫描独立，保留上次读到的文件数。
      }
    },
    [acceptObservedHead, canReadRepository, canReadStatus, targetCwd, workspacePath]
  )

  useEffect(() => {
    if (environmentRailCollapsed) closeMenu()
  }, [closeMenu, environmentRailCollapsed])

  useEffect(() => {
    if (!open) return
    return observeWorkbenchDialogOpen(() => {
      menuOpensDialog.current = true
      closeMenu()
    })
  }, [closeMenu, open])

  useEffect(() => {
    if (open && gitRepoChecked && isGitRepo) void loadBranches()
  }, [branchListRevision, gitRepoChecked, isGitRepo, open, loadBranches])

  const selectRepository = (repoPath: string): void => {
    if (repoPath === selectedRepositoryPath) return
    branchListRequest.current++
    queuedSearchKey.current = undefined
    unverifiedBranchChanges.current.clear()
    setSelectedRepositoryPath(repoPath)
    if (branchListRef.current) branchListRef.current.scrollTop = 0
    setBranches(emptyBranchLists)
    setDirtyStatus(null)
    setBranchListStatus("loading")
    setSearchQuery("")
    setBranchScrollTop(0)
    setActionError(null)
    setListError(null)
  }

  const changeBranch = useCallback(
    async (choice: GitBranchChoice, create = false) => {
      if (
        !choice.name || !targetCwd || !targetRoot || !canChangeBranch || pendingMutations.current.has(targetRoot)
      ) return
      const shownAsCurrent = !create && choice.kind === "local" && choice.name === activeBranch
      const request = Symbol()
      pendingMutations.current.set(targetRoot, request)
      setSwitchingRoots(new Set(pendingMutations.current.keys()))
      const isPending = () => pendingMutations.current.get(targetRoot) === request
      const isCurrent = () => isPending() && selectedRepositoryPathRef.current === selectedRepositoryPath
      const failure = create ? "创建分支失败" : "切换分支失败"
      const repoLabel = selectedRepository ? `${selectedRepository.displayPath} ` : ""
      const reportFailure = (error: string): void => {
        const foreground = isCurrent()
        if (!foreground || (create && !createDialogOpen.current)) {
          const label = foreground ? `${repoLabel}${failure}` : `${targetCwd} ${failure}`
          toast.error(label, { description: error })
          return
        }
        setActionError(error)
        if (create) newBranchInputRef.current?.focus()
        else if (!menuOpen.current) toast.error(error)
      }
      setActionError(null)
      let finishCheckout: (() => void) | undefined
      try {
        if (shownAsCurrent && targetGitDir) {
          // The highlighted row may lag an external checkout.
          const verifiedHead = await window.api.git.readBranchHead(targetGitDir).catch(() => undefined)
          if (!isPending() || verifiedHead === choice.name) return
        }
        finishCheckout = beginGitCheckout(targetRoot)
        const result = create
          ? await window.api.git.createBranch(choice.name, targetCwd)
          : await window.api.git.switchBranch(choice.name, targetCwd, choice.kind)
        if (result.headChanged && result.branch !== undefined && workspacePath) {
          notifyGitBranchSwitched({
            workspacePath,
            repositoryPath: targetCwd,
            branch: result.branch,
            ...(result.gitRoot ? { gitRoot: result.gitRoot } : {}),
            ...(result.gitDir ? { gitDir: result.gitDir } : {})
          })
        }
        const foreground = isCurrent()
        if (foreground && result.branch !== undefined) {
          if (result.headChanged) updateHead(targetCwd, result.branch)
          else acceptObservedHead(result.branch)
          if (pendingBranchHead.current === targetGitDir) pendingBranchHead.current = undefined
        }
        if (!result.success) {
          reportFailure(result.error || failure)
          return
        }

        if (foreground) {
          if (shownAsCurrent && !result.headChanged) return
          setDirtyStatus(null)
          if (create) closeCreateDialog()
          else closeMenu()
        }
        if (!result.headChanged) return

        const label = create ? "已创建并检出新分支" : "已切换分支"
        const sourceLabel = foreground ? repoLabel : `${targetCwd} `
        const showSuccess = () => toast.success(`${sourceLabel}${label} ${result.branch}`, {
          description: result.warning
        })
        if (create && foreground && !document.hidden) {
          // Sonner synchronously measures new notifications. Paint the restored workbench first.
          requestAnimationFrame(() => setTimeout(showSuccess, 0))
        } else {
          showSuccess()
        }
      } catch (err) {
        reportFailure(err instanceof Error ? err.message : failure)
      } finally {
        finishCheckout?.()
        if (isPending()) {
          pendingMutations.current.delete(targetRoot)
          setSwitchingRoots(new Set(pendingMutations.current.keys()))
        }
      }
    },
    [
      acceptObservedHead,
      activeBranch,
      canChangeBranch,
      closeCreateDialog,
      closeMenu,
      selectedRepository,
      selectedRepositoryPath,
      targetCwd,
      targetGitDir,
      targetRoot,
      updateHead,
      workspacePath
    ]
  )

  const busy = switching
  const searchName = trimGitBranchInput(searchQuery)
  const query = searchName.toLowerCase()
  const searchReady = branchSearch?.branches === branches && branchSearch.query === query
  const searchPending = Boolean(query && branches.searchNames && !searchReady)
  useEffect(() => {
    if (!open || !query || !branches.searchNames) return
    let disposed = false
    const isCurrent = () => !disposed && menuOpen.current
    void searchBranchLists(branches, branches.searchNames, query, isCurrent).then((matches) => {
      if (matches && isCurrent()) setBranchSearch({ branches, query, matches })
    })
    return () => {
      disposed = true
    }
  }, [branches, open, query])

  const { local: localChoices, remote: remoteChoices } = useMemo(() => {
    if (!query) return branches
    if (branches.searchNames) return searchReady ? branchSearch.matches : emptyBranchLists
    const matches = (name: string): boolean => name.toLowerCase().includes(query)
    return { local: branches.local.filter(matches), remote: branches.remote.filter(matches) }
  }, [branches, query, branchSearch, searchReady])
  const currentIndex = useMemo(
    () => activeBranch === null ? -1 : localChoices.indexOf(activeBranch),
    [activeBranch, localChoices]
  )
  const choiceCount = localChoices.length + remoteChoices.length
  const loadingBranches = branchListStatus === "loading"
  const branchListPending =
    loadingBranches && branches.local.length === 0 && branches.remote.length === 0
  const extra =
    currentIndex >= 0 &&
    dirtyStatus?.branch === activeBranch &&
    dirtyStatus?.count
      ? dirtyRowExtra
      : 0
  const remoteTop = localChoices.length
    ? branchHeaderHeight + localChoices.length * branchRowHeight + extra
    : 0
  const branchContentHeight = remoteTop + (remoteChoices.length
    ? branchHeaderHeight + remoteChoices.length * branchRowHeight
    : 0)
  // Keep the scrollbar within Chromium's layout range and keep visible rows full height.
  const branchCanvasHeight = Math.min(branchContentHeight, maxScrollHeight)
  const physicalScrollTop = Math.min(branchScrollTop, Math.max(0, branchCanvasHeight - branchListHeight))
  const logicalScrollTop = mapScrollPosition(physicalScrollTop, branchCanvasHeight, branchContentHeight)
  const branchScrollOffset = logicalScrollTop - physicalScrollTop

  function focusChoice(index: number): void {
    const list = branchListRef.current
    if (!list || index < 0 || index >= choiceCount) return
    const local = index < localChoices.length
    const top = local
      ? branchHeaderHeight + index * branchRowHeight + (index > 0 ? extra : 0)
      : remoteTop + branchHeaderHeight + (index - localChoices.length) * branchRowHeight
    const bottom = top + branchRowHeight + (index === 0 ? extra : 0)
    const currentTop = mapScrollPosition(list.scrollTop, branchCanvasHeight, branchContentHeight)
    const nextTop = Math.min(top, Math.max(currentTop, bottom - list.clientHeight))
    if (nextTop !== currentTop)
      list.scrollTop = mapScrollPosition(nextTop, branchContentHeight, branchCanvasHeight)
    flushSync(() => setBranchScrollTop(list.scrollTop))
    list
      .querySelector<HTMLButtonElement>(`[data-branch-index="${index}"]`)
      ?.focus({ preventScroll: true })
  }

  function applySearchKey(key: SearchKey): void {
    if (!choiceCount || busy) return
    if (!canChangeBranch) {
      if (key === "ArrowDown") branchListRef.current?.focus({ preventScroll: true })
      return
    }
    if (key === "ArrowDown") focusChoice(0)
    else if (query && branchListStatus === "ready") {
      if (choiceCount === 1) {
        const kind = localChoices.length ? "local" : "remote"
        void changeBranch({ name: localChoices[0] ?? remoteChoices[0], kind })
      } else {
        const local = localChoices.includes(searchName)
        const remote = remoteChoices.includes(searchName)
        if (local !== remote) {
          void changeBranch({ name: searchName, kind: local ? "local" : "remote" })
        } else {
          focusChoice(0)
        }
      }
    }
  }

  function isSearchKeyPending(key: SearchKey): boolean {
    return searchPending || branchListPending || (key === "Enter" && loadingBranches)
  }

  useEffect(() => {
    const queued = queuedSearchKey.current
    if (!open || !queued || isSearchKeyPending(queued.key)) return
    // Run after the results render so keyboard navigation can focus a virtual row.
    const timer = setTimeout(() => {
      if (queuedSearchKey.current !== queued || !menuOpen.current) return
      queuedSearchKey.current = undefined
      if (queued.value === searchQuery && document.activeElement === searchInputRef.current) {
        applySearchKey(queued.key)
      }
    }, 0)
    return () => clearTimeout(timer)
  })

  const missingBranchLabel = repositoryNeedsProbe && !repositoryError ? "读取中…" : "未识别分支"
  const branchLabel = isMultiRepo
    ? `${selectedRepository?.displayPath ?? "选择仓库"} · ${activeBranch || missingBranchLabel}`
    : currentBranch || "未识别分支"

  const renderBranchButton = (
    name: string,
    kind: GitBranchChoice["kind"],
    index: number
  ): React.JSX.Element => {
    const isCurrent = kind === "local" && name === activeBranch
    const changedFileCount = isCurrent && name === dirtyStatus?.branch ? dirtyStatus.count : 0
    return (
      <button
        key={`${kind}:${name}`}
        ref={retainListFocus}
        aria-current={isCurrent ? "true" : undefined}
        data-branch-choice
        data-branch-index={index}
        style={{ height: branchRowHeight + (index === 0 ? extra : 0) }}
        type="button"
        disabled={busy || !canChangeBranch}
        onClick={() => void changeBranch({ name, kind })}
        className={cn(
          "w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          isCurrent
            ? "bg-muted text-foreground font-medium"
            : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
          (busy || !canChangeBranch) && !isCurrent && "opacity-50 cursor-not-allowed"
        )}
      >
        <GitBranch className="size-3 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate">{name}</span>
          {isCurrent && changedFileCount > 0 && (
            <span className="text-xs text-muted-foreground">
              未提交的更改：{changedFileCount} 个文件
            </span>
          )}
        </span>
        {isCurrent &&
          (switching ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : (
            <Check className="size-3 shrink-0 text-primary" />
          ))}
      </button>
    )
  }

  function renderGroup(choices: string[], local: boolean) {
    if (!choices.length) return null
    const groupTop = local ? 0 : remoteTop
    const rowsTop = groupTop + branchHeaderHeight
    const firstExtra = local ? extra : 0
    const rowStart = (index: number) => index * branchRowHeight + (index > 0 ? firstExtra : 0)
    const from = Math.max(
      0,
      Math.min(
        choices.length,
        Math.floor((logicalScrollTop - rowsTop - firstExtra) / branchRowHeight) - branchOverscanRows
      )
    )
    const to = Math.max(
      from,
      Math.min(
        choices.length,
        Math.ceil((logicalScrollTop + branchListHeight - rowsTop) / branchRowHeight) + branchOverscanRows
      )
    )
    if (from === to) return null
    const showHeader = from === 0
    const top = (showHeader ? groupTop : rowsTop + rowStart(from)) - branchScrollOffset
    return (
      <div
        role="group"
        aria-label={local ? "本地分支" : "远程分支"}
        style={{ position: "absolute", insetInline: 0, top }}
      >
        {showHeader && (
          <div
            className="px-3 py-1 text-xs text-muted-foreground"
            style={{ height: branchHeaderHeight }}
          >
            {local ? "分支" : "远程分支"}
          </div>
        )}
        {Array.from({ length: to - from }, (_, offset) => {
          const row = from + offset
          // Pin the current branch without copying the entire list.
          let source = row
          if (local && currentIndex > 0 && row <= currentIndex) {
            source = row === 0 ? currentIndex : row - 1
          }
          return renderBranchButton(choices[source], local ? "local" : "remote", local ? row : localChoices.length + row)
        })}
      </div>
    )
  }

  if (!gitRepoChecked) return null

  if (!isGitRepo) {
    const unavailable = Boolean(gitStatusError)
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!unavailable}
              aria-label={unavailable ? "重新读取 Git 仓库" : undefined}
              onClick={() => setProbeRevision((revision) => revision + 1)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
                unavailable
                  ? "text-destructive border border-destructive/40 bg-destructive/10 cursor-pointer opacity-100 max-w-[200px]"
                  : "text-muted-foreground cursor-not-allowed opacity-70 max-w-[200px]"
              )}
            >
              <GitBranch className="size-3 shrink-0" />
              <span className="truncate">{unavailable ? "Git 读取失败，重试" : "非 Git 仓库"}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            <p>{gitStatusError ?? "当前工作区不是 Git 仓库，无法切换分支"}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        aria-haspopup="dialog"
        aria-controls={branchMenuId}
        aria-expanded={open}
        aria-label="切换 Git 分支"
        aria-describedby={branchLabelId}
        popoverTarget={branchMenuId}
        style={{ anchorName: branchAnchorName }}
        title={
          isMultiRepo
            ? "点击选择子仓库并切换分支"
            : !canChangeBranch
              ? "查看分支和 Git 图谱"
              : "点击切换分支"
        }
        type="button"
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs font-medium",
          "text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          isMultiRepo ? "max-w-[260px]" : "max-w-[200px]"
        )}
      >
        <GitBranch className="size-3 shrink-0" />
        <span id={branchLabelId} className="truncate">{branchLabel}</span>
        {busy ? (
          <Loader2 className="size-3 shrink-0 animate-spin" />
        ) : (
          <ChevronDown className="size-3 shrink-0" />
        )}
      </button>

        <BranchMenu
          id={branchMenuId}
          anchorName={branchAnchorName}
          menuRef={branchMenuRef}
          triggerRef={triggerRef}
          onBeforeToggle={handleMenuBeforeToggle}
          onOpen={handleMenuOpened}
          onDismiss={closeMenu}
        >
          {open && isMultiRepo && (
            <div className="px-2 py-2 border-b border-border">
              <label className="block text-[11px] font-medium text-muted-foreground">
                子仓库
                <select
                  value={selectedRepositoryPath ?? ""}
                  onChange={(event) => selectRepository(event.target.value)}
                  className={cn(
                    "mt-1 w-full rounded-sm border border-border bg-background px-2 py-1 text-xs text-foreground",
                    "focus:outline-none focus:border-ring"
                  )}
                >
                  {repositories.map((repo) => (
                    <option key={repo.path} value={repo.path}>
                      {repo.displayPath}
                      {repo.branch !== undefined && ` · ${repo.branch ?? "未识别分支"}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {repositoryError && (
            <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
              {repositoryError}
            </p>
          )}
          {repositoryNeedsProbe && !repositoryError && (
            <p role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
              正在读取子仓库状态…
            </p>
          )}
          {activeRepositoryIsWorktree && (
            <p className="border-b px-3 py-2 text-xs text-muted-foreground">
              Worktree 模式下无法创建或切换分支。
            </p>
          )}
          {!activeRepositoryIsWorktree && activeRepositoryInsideWorkTree === false && (
            <p className="border-b px-3 py-2 text-xs text-muted-foreground">
              当前目录不在工作树内，无法创建或切换分支。
            </p>
          )}

          <div className="flex items-center gap-2 border-b px-3 text-muted-foreground">
            <Search className="size-4 shrink-0" />
            <input
              ref={setSearchInput}
              type="text"
              aria-label="搜索分支"
              placeholder="搜索分支"
              value={searchQuery}
              onChange={(event) => {
                queuedSearchKey.current = undefined
                setSearchQuery(event.target.value)
                setBranchScrollTop(0)
                if (branchListRef.current) branchListRef.current.scrollTop = 0
              }}
              onBlur={() => {
                queuedSearchKey.current = undefined
              }}
              onKeyDown={(event) => {
                const key = event.key
                if ((key !== "ArrowDown" && key !== "Enter") || event.nativeEvent.isComposing) return
                const pending = !open || isSearchKeyPending(key)
                if (busy || (!choiceCount && !pending)) return
                event.preventDefault()
                if (pending) queuedSearchKey.current = { key, value: searchQuery }
                else {
                  queuedSearchKey.current = undefined
                  applySearchKey(key)
                }
              }}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none"
            />
            <button
              type="button"
              onClick={() => void loadBranches(true)}
              disabled={!open || !canReadRepository || loadingBranches || busy}
              className="flex items-center justify-center size-5 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
              title="刷新分支列表"
            >
              <RefreshCw className={cn("size-3", loadingBranches && "animate-spin")} />
            </button>
          </div>

          {/* 错误提示 */}
          {(actionError || listError) && (
            <div
              role="alert"
              className="flex items-start gap-1.5 px-3 py-2 bg-destructive/10 text-destructive text-[11px] border-b border-border"
            >
              <AlertCircle className="size-3 mt-0.5 shrink-0" />
              <span className="leading-snug break-all">{actionError || listError}</span>
            </div>
          )}

          {/* 分支列表 */}
          <div
            ref={branchListRef}
            role="region"
            aria-label="分支列表"
            tabIndex={choiceCount && !canChangeBranch ? 0 : -1}
            className="overflow-y-auto px-1"
            style={{ maxHeight: branchListHeight }}
            onScroll={(event) => {
              const top = event.currentTarget.scrollTop
              const next = mapScrollPosition(top, branchCanvasHeight, branchContentHeight)
              if (Math.abs(next - logicalScrollTop) > branchOverscanRows * branchRowHeight)
                flushSync(() => setBranchScrollTop(top))
              else setBranchScrollTop(top)
            }}
            onKeyDown={(event) => {
              if (!["ArrowDown", "ArrowUp"].includes(event.key)) return
              const index = (event.target as HTMLElement).closest<HTMLButtonElement>(
                "[data-branch-index]"
              )?.dataset.branchIndex
              if (!choiceCount || !canChangeBranch || busy) return
              event.preventDefault()
              const down = event.key === "ArrowDown"
              if (index !== undefined) {
                focusChoice((Number(index) + (down ? 1 : -1) + choiceCount) % choiceCount)
              } else {
                const list = event.currentTarget
                const first = mapScrollPosition(list.scrollTop, branchCanvasHeight, branchContentHeight)
                const edge = first + (down ? 0 : list.clientHeight - 1)
                const local = edge < remoteTop || !remoteChoices.length
                const base = local ? 0 : localChoices.length
                const offset = edge - (local ? extra : remoteTop) - branchHeaderHeight
                const row = Math.max(0, Math.floor(offset / branchRowHeight))
                focusChoice(base + Math.min(row, (local ? localChoices : remoteChoices).length - 1))
              }
            }}
          >
            {!open || branchListPending || searchPending ? (
              <div
                role="status"
                className="flex items-center justify-center gap-1.5 py-4 text-xs text-muted-foreground"
              >
                <Loader2 className="size-3 animate-spin" />
                {!open || branchListPending ? "加载中..." : "搜索中..."}
              </div>
            ) : choiceCount === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                {searchQuery ? "没有匹配的分支" : "暂无分支"}
              </div>
            ) : (
              <div style={{ position: "relative", overflow: "clip", height: branchCanvasHeight }}>
                {renderGroup(localChoices, true)}
                {renderGroup(remoteChoices, false)}
              </div>
            )}
          </div>
          <div className="border-t border-border p-1">
            {canChangeBranch && (
              <button
                type="button"
                disabled={busy}
                className={menuActionClass}
                onClick={() => {
                  menuOpensDialog.current = true
                  closeMenu()
                  // showModal restores focus to this invoker when the dialog closes.
                  triggerRef.current?.focus({ preventScroll: true })
                  setActionError(null)
                  createDialogOpen.current = true
                  React.startTransition(() => setNewBranchName(""))
                }}
              >
                <Plus className="size-4 text-muted-foreground" /> 创建并检出新分支…
              </button>
            )}
            <button
              type="button"
              disabled={!canReadRepository}
              className={menuActionClass}
              onClick={() => {
                menuOpensDialog.current = true
                // Opening the graph's native popover also dismisses this menu.
                setGraphOpen(true)
              }}
            >
              <GitGraph className="size-4 text-muted-foreground" /> Git 图谱
            </button>
          </div>
        </BranchMenu>
      {newBranchName !== null && createPortal(
        <dialog
          ref={newBranchDialogRef}
          closedby="any"
          data-cmb-modal-dialog="true"
          aria-labelledby={`${newBranchNameId}-title`}
          aria-describedby={`${newBranchNameId}-description`}
          className="fixed inset-0 m-auto w-[min(32rem,94vw)] max-w-lg rounded-2xl border border-border bg-popover p-6 text-foreground shadow-lg backdrop:bg-black/35 [-webkit-app-region:no-drag]"
          onCancel={(event) => {
            event.preventDefault()
            closeCreateDialog()
          }}
        >
          <h2 id={`${newBranchNameId}-title`} className="text-lg font-medium leading-none tracking-tight">
            创建并检出新分支
          </h2>
          <p id={`${newBranchNameId}-description`} className="mt-2 text-sm leading-6 text-muted-foreground">
            基于当前 HEAD 创建一个新的本地分支，并在创建成功后立即切换过去。
            {busy && "关闭后，Git 操作会继续。"}
          </p>
          <form
            className="mt-6 space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void changeBranch({ name: trimGitBranchInput(newBranchName), kind: "local" }, true)
            }}
          >
            <label className="block text-sm font-medium" htmlFor={newBranchNameId}>
              分支名
            </label>
            <input
              id={newBranchNameId}
              ref={newBranchInputRef}
              value={newBranchName}
              readOnly={busy}
              placeholder="例如 feature/git-branch-switcher"
              onChange={(event) => {
                setNewBranchName(event.target.value)
                setActionError(null)
              }}
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-ring"
            />
            {actionError && (
              <p role="alert" className="text-sm text-destructive">
                {actionError}
              </p>
            )}
            <DialogFooter className="pt-5">
              <Button
                type="button"
                variant="secondary"
                className="h-10 rounded-lg px-5"
                onClick={closeCreateDialog}
              >
                {busy ? "关闭" : "取消"}
              </Button>
              <Button
                type="submit"
                className="h-10 rounded-lg bg-foreground px-5 text-background hover:bg-foreground/90"
                disabled={busy || !trimGitBranchInput(newBranchName)}
              >
                {busy && <Loader2 className="size-4 animate-spin" />}创建并切换
              </Button>
            </DialogFooter>
          </form>
          <button
            type="button"
            aria-label="关闭创建分支弹窗"
            className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 focus-visible:ring-2"
            onClick={closeCreateDialog}
          >
            <X className="size-4" />
          </button>
        </dialog>,
        document.body
      )}
      {graphOpen && (
        <GitGraphDialog
          key={targetCwd}
          cwd={targetCwd}
          gitDir={targetGitDir}
          onClose={() => {
            closeMenu()
            setGraphOpen(false)
          }}
          onCloseAutoFocus={() => triggerRef.current?.focus()}
        />
      )}
    </>
  )
}
