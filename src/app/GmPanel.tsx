/**
 * GM 모드 채팅 패널 — 자유 입력을 LLM 마스터가 도구 호출로 번역해 게임을 진행한다.
 * 기존 버튼 UI 와 같은 GameState 를 공유하므로 병행 조작이 가능하다.
 */
import { useEffect, useRef, useState } from 'react'
import type { GameData } from '../system/types'
import type { RNG } from '../system/rng'
import type { GameState } from './session'
import type { ChatMessage } from '../llm/gm'
import { loadApiKey, saveApiKey, loadModel, saveModel, runGmTurn, DEFAULT_MODEL } from '../llm/gm'

export function GmPanel({
  data,
  rng,
  state,
  setState,
}: {
  data: GameData
  rng: RNG
  state: GameState
  setState: (s: GameState) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(!loadApiKey())
  const [keyDraft, setKeyDraft] = useState(loadApiKey())
  const [modelDraft, setModelDraft] = useState(loadModel())
  const [showNotes, setShowNotes] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const history = [...messages, { role: 'user' as const, text }]
    setMessages(history)
    setBusy(true)
    try {
      const out = await runGmTurn(rng, data, stateRef.current, messages, text)
      setState(out.state)
      const next = [...history, ...out.messages]
      if (out.error) next.push({ role: 'system-note', text: `⚠ ${out.error}` })
      setMessages(next)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel">
      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>GM 모드 — 마스터와 대화</span>
        <button style={{ fontSize: '0.75rem', padding: '4px 10px' }}
          onClick={() => setShowSettings(!showSettings)}>
          설정
        </button>
      </h2>

      {showSettings && (
        <div className="event-card" style={{ marginBottom: 10 }}>
          <p className="muted" style={{ marginTop: 0, fontSize: '0.82rem' }}>
            Anthropic API 키는 <strong>이 브라우저에만</strong> 저장되고, 대화·게임 상태가 API 로 전송된다.
            키 발급: console.anthropic.com → API Keys. 비용은 본인 키로 청구된다.
          </p>
          <div className="field">
            <label>API 키</label>
            <input type="password" value={keyDraft} placeholder="sk-ant-..."
              onChange={(e) => setKeyDraft(e.target.value)} />
          </div>
          <div className="field">
            <label>모델</label>
            <input type="text" value={modelDraft} placeholder={DEFAULT_MODEL}
              onChange={(e) => setModelDraft(e.target.value)} />
          </div>
          <div className="button-row">
            <button className="primary" onClick={() => {
              saveApiKey(keyDraft.trim())
              saveModel(modelDraft.trim() || DEFAULT_MODEL)
              setShowSettings(false)
            }}>저장</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem' }}>
              <input type="checkbox" checked={showNotes} onChange={(e) => setShowNotes(e.target.checked)} />
              판정 내역 표시
            </label>
          </div>
        </div>
      )}

      <div style={{ maxHeight: 380, overflowY: 'auto', marginBottom: 10 }}>
        {messages.length === 0 && (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            자유롭게 말하면 마스터가 규칙 판정으로 옮긴다 — "주변을 살피고 싶어",
            "설득해 본다", "검을 뽑는다", "다음 시프트로 이동하자" 같은 식으로.
            판정 주사위는 전부 게임 엔진이 굴린다.
          </p>
        )}
        {messages.map((m, i) => {
          if (m.role === 'system-note') {
            if (!showNotes) return null
            return (
              <div key={i} className="muted" style={{ fontSize: '0.75rem', margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                {m.text}
              </div>
            )
          }
          return (
            <div key={i} style={{
              margin: '8px 0', padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? 'var(--bg-raised)' : 'transparent',
              border: m.role === 'user' ? '1px solid var(--border)' : 'none',
              fontSize: '0.9rem',
            }}>
              <strong style={{ opacity: 0.6, fontSize: '0.75rem' }}>
                {m.role === 'user' ? state.character.name : 'GM'}
              </strong>
              <div>{m.text}</div>
            </div>
          )
        })}
        {busy && <p className="muted" style={{ fontSize: '0.85rem' }}>마스터가 주사위를 굴리는 중…</p>}
        <div ref={bottomRef} />
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" value={input} style={{ flex: 1 }}
          placeholder="무엇을 할까? (Enter 로 전송)"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void send() }} />
        <button className="primary" disabled={busy || !input.trim()} onClick={() => void send()}>
          전송
        </button>
      </div>
    </section>
  )
}
