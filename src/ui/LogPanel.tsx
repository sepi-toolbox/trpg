import { useEffect, useRef } from 'react'

export interface LogLine {
  id: number
  kind: string
  text: string
  round?: number
}

export function LogPanel({ lines, title }: { lines: LogLine[]; title: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <section className="panel">
      <h3>{title}</h3>
      <div className="log" ref={ref}>
        {lines.length === 0 && <p>기록이 없습니다.</p>}
        {lines.map((line) => (
          <p key={line.id} className={line.kind}>
            {line.round !== undefined && <span className="round-tag">R{line.round}</span>}
            {line.text}
          </p>
        ))}
      </div>
    </section>
  )
}
