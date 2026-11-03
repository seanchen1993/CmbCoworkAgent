/** User-facing stage reference. It never grants permission or authorizes stage execution. */
export function isProjectUserGuide(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4000 &&
    // eslint-disable-next-line no-control-regex -- Allow Markdown whitespace, reject hidden controls.
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  )
}
