export function SparksOperationError({ message }: { message: string }): React.JSX.Element {
  const technical = /MODS_|AUTHORING_|Error:|\b(?:Claw|Function|native|manifest)\b/i.test(message)
  return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{technical ? "这一步没有完成。请重试；若仍失败，可展开详情定位问题。" : message}</p>
      {technical && (
        <details className="text-xs">
          <summary className="cursor-pointer">技术详情</summary>
          <pre className="mt-2 whitespace-pre-wrap break-all">{message}</pre>
        </details>
      )}
    </div>
  )
}
