import { useEffect, useRef } from 'react'
import type { LogEntry } from './session'

const KIND_CLASS: Record<LogEntry['kind'], string> = {
  system: 'system',
  good: 'good',
  bad: 'bad',
  info: '',
  combat: 'hit',
  crit: 'crit',
}

export function LogPanel({ lines }: { lines: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  return (
    <section className="panel">
      <h3>기록</h3>
      <div className="log" ref={ref}>
        {lines.length === 0 && <p>아직 기록이 없습니다.</p>}
        {lines.slice(-80).map((line) => (
          <p key={line.id} className={KIND_CLASS[line.kind]}>
            {line.text}
          </p>
        ))}
      </div>
    </section>
  )
}
