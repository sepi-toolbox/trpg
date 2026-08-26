import { useCallback, useMemo, useRef, useState } from 'react'
import { loadGameData } from '../system/load'
import { createRNG } from '../system/rng'
import type { RNG } from '../system/rng'
import type { Character } from '../system/character'
import { SESSION_QUESTIONS } from '../system/character'
import type { GameState } from './session'
import {
  eveningHunt,
  eveningRest,
  eveningSkip,
  runDebrief,
  startGame,
  travelShift,
  JOURNEY_TOTAL_KM,
} from './session'
import { CreationView } from './CreationView'
import { SheetPanel } from './SheetPanel'
import { CombatPanel } from './CombatPanel'
import { LogPanel } from './LogPanel'

export default function App() {
  const data = useMemo(() => loadGameData(), [])
  const [state, setState] = useState<GameState | null>(null)
  const rngRef = useRef<RNG | null>(null)

  const start = useCallback((character: Character, seed: number) => {
    rngRef.current = createRNG(seed ^ 0x5eed)
    setState(startGame(seed, character))
  }, [])

  const reset = () => {
    rngRef.current = null
    setState(null)
  }

  const rng = rngRef.current

  return (
    <>
      <header className="app-header">
        <div>
          <h1>황야의 파수탑</h1>
          <div className="subtitle">
            D20 하향 판정 · 카드 선제 · 데이터 테이블 기반 — DB 시스템 초벌
          </div>
        </div>
        {state && (
          <button className="danger" onClick={reset}>처음으로</button>
        )}
      </header>

      {!state || !rng ? (
        <CreationView data={data} onStart={start} />
      ) : (
        <GameScreen data={data} rng={rng} state={state} setState={setState} onReset={reset} />
      )}
    </>
  )
}

function GameScreen({
  data,
  rng,
  state,
  setState,
  onReset,
}: {
  data: ReturnType<typeof loadGameData>
  rng: RNG
  state: GameState
  setState: (s: GameState) => void
  onReset: () => void
}) {
  const [answers, setAnswers] = useState<boolean[]>(SESSION_QUESTIONS.map(() => false))

  return (
    <div className="grid grid-2">
      <SheetPanel data={data} state={state} />

      <div>
        {state.screen === 'journey' && (
          <section className="panel">
            <h2>{state.day}일차 — 황야</h2>
            <p className="muted">
              {state.kmTraveled >= JOURNEY_TOTAL_KM
                ? '파수탑 문 앞이다. 안쪽의 수호자와 결판을 내야 한다.'
                : `파수탑까지 ${JOURNEY_TOTAL_KM - state.kmTraveled}km. 오늘 ${state.shiftsTraveledToday}/2시프트 이동. 시프트마다 야외술로 길을 찾는다.`}
            </p>
            <div className="button-row">
              <button className="primary" onClick={() => setState(travelShift(rng, data, state))}>
                {state.kmTraveled >= JOURNEY_TOTAL_KM ? '파수탑으로 들어간다 — 결전' : '다음 시프트 이동'}
              </button>
              {state.shiftsTraveledToday >= 2 && (
                <button onClick={() => setState(travelShift(rng, data, state, true))}>
                  강행군 (탈진)
                </button>
              )}
            </div>
          </section>
        )}

        {state.screen === 'evening' && (
          <section className="panel">
            <h2>저녁 — 야영 준비</h2>
            <p className="muted">해가 진다. 잠들기 전 한 시프트를 쓸 수 있다.</p>
            <div className="button-row">
              <button className="primary" onClick={() => setState(eveningRest(rng, data, state))}>
                휴식 (스트레치 — HP·WP·상태이상)
              </button>
              <button onClick={() => setState(eveningHunt(rng, data, state))}>
                사냥 (식량 조달)
              </button>
              <button onClick={() => setState(eveningSkip(rng, data, state))}>
                바로 잔다
              </button>
            </div>
          </section>
        )}

        {state.screen === 'combat' && state.combat && (
          <CombatPanel data={data} rng={rng} state={state} setState={setState} />
        )}

        {state.screen === 'cleared' && !state.debrief && (
          <section className="panel ending win">
            <div className="headline">임무 완수</div>
            <p className="muted">
              {state.day}일 만에 파수탑의 수호자를 쓰러뜨렸다.
            </p>
            <DebriefForm answers={answers} setAnswers={setAnswers}
              onSubmit={(marks) => setState(runDebrief(rng, state, marks))}
              character={state.character} />
          </section>
        )}

        {state.screen === 'dead' && !state.debrief && (
          <section className="panel ending lose">
            <div className="headline">쓰러지다</div>
            <p className="muted">{state.day}일차, 황야가 또 한 명을 삼켰다.</p>
            <button className="primary" onClick={onReset}>새 모험가</button>
          </section>
        )}

        {state.screen === 'debrief' && state.debrief && (
          <section className="panel">
            <h2>성장 정산</h2>
            {state.debrief.length === 0 && <p className="muted">이번 모험에는 성장 마크가 없었다.</p>}
            {state.debrief.map((r, i) => (
              <div className="kv" key={i}>
                <span className="k">{data.skills.find((s) => s.id === r.skillId)?.name ?? r.skillId}</span>
                <span className="v">
                  D20={r.roll} → {r.improved ? `${r.before} → ${r.after} ⬆` : '변화 없음'}
                </span>
              </div>
            ))}
            <button className="primary" style={{ marginTop: 10 }} onClick={onReset}>
              새 모험
            </button>
          </section>
        )}

        <LogPanel lines={state.log} />
      </div>
    </div>
  )
}

function DebriefForm({
  answers,
  setAnswers,
  onSubmit,
  character,
}: {
  answers: boolean[]
  setAnswers: (a: boolean[]) => void
  onSubmit: (extraMarkSkillIds: string[]) => void
  character: Character
}) {
  return (
    <div style={{ textAlign: 'left', marginTop: 12 }}>
      <h3>세션 질문 — 예라고 답한 만큼 추가 성장 마크</h3>
      {SESSION_QUESTIONS.map((q, i) => (
        <div key={i} style={{ margin: '6px 0' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={answers[i]}
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.checked : a)))} />
            {q}
          </label>
        </div>
      ))}
      <button className="primary" style={{ marginTop: 8 }}
        onClick={() => {
          // 추가 마크: 훈련 스킬 앞에서부터 배정 (초벌 — 선택 UI는 추후)
          const yes = answers.filter(Boolean).length
          const candidates = character.trainedSkillIds
            .filter((id) => !character.advancementMarks.includes(id))
            .slice(0, yes)
          onSubmit(candidates)
        }}>
        성장 굴림
      </button>
    </div>
  )
}
