/** The installer outlives Electron. Stage beside the destination so publishing
 * a complete file is a same-filesystem replacement, never an in-place write. */
export function powerShellAtomicCopy(): string {
  return `function Copy-UpdateFileAtomically {
  param([string] $Source, [string] $Destination)
  $stagedPath = $Destination + '.stage.' + [System.Guid]::NewGuid().ToString('N')
  try {
    Copy-Item -LiteralPath $Source -Destination $stagedPath -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Destination) {
      # ReplaceFile preserves the installed destination's permissions/metadata.
      [System.IO.File]::Replace($stagedPath, $Destination, $null)
    } else {
      [System.IO.File]::Move($stagedPath, $Destination)
    }
  } finally {
    if (Test-Path -LiteralPath $stagedPath) {
      Remove-Item -LiteralPath $stagedPath -Force -ErrorAction SilentlyContinue
    }
  }
}
`
}

export function bashAtomicCopy(): string {
  return `copy_update_file_atomically() (
  source_file="$1"
  destination_file="$2"
  staged_file="$(mktemp "\${destination_file}.stage.XXXXXX")" || exit 1
  # A subshell owns this trap; the caller retains its diagnostic EXIT handler.
  trap 'rm -f "$staged_file"' EXIT
  # Keep the installed file's mode instead of the private download's mode.
  if [ -f "$destination_file" ]; then
    cp -p "$destination_file" "$staged_file" || exit 1
  fi
  cp -f "$source_file" "$staged_file" || exit 1
  mv -f "$staged_file" "$destination_file"
)
`
}
