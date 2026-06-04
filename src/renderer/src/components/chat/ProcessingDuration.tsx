import React, { useEffect, useRef, useState } from "react"

import { DurationShow } from "./DurationShow"

interface ProcessingDurationProps {
  startTime: number | null
  text?: string
}

export function ProcessingDuration({
  startTime,
  text = "已处理"
}: ProcessingDurationProps): React.JSX.Element | null {
  const [durationMs, setDurationMs] = useState<number>(0)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }

    if (typeof startTime !== "number" || !Number.isFinite(startTime)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDurationMs(0)
      return
    }

    const safeStartTime = startTime
    timer.current = window.setInterval(() => {
      setDurationMs(Math.max(0, Date.now() - safeStartTime))
    }, 1000)

    return () => {
      if (timer.current !== null) {
        window.clearInterval(timer.current)
      }
      timer.current = null
    }
  }, [startTime])

  return <DurationShow text={text} durationMs={durationMs} />
}
