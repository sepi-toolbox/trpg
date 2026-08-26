import { useCallback, useMemo, useRef, useState } from 'react'
import { loadGameData } from '../system/load'
import { createRNG } from '../system/rng'
import type { RNG } from '../system/rng'
import type { Character } from '../system/character'
import { SESSION_QUESTIONS } from '../system/character'
import type { GameState } from './session'
import {
  eveningCastSpell,
  eveningFish,
  eveningHunt,
  eveningPrepareSpells,
  eveningRepair,
  eveningRest,
  eveningSkip,
  preparedSpellLimit,
  runDebrief,
  startGame,
  travelShift,
  JOURNEY_TOTAL_KM,
} from './session'
import { CreationView } from './CreationView'
import { SheetPanel } from './SheetPanel'
import { CombatPanel } from './CombatPanel'
import { GmPanel } from './GmPanel'
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
  const [gmMode, setGmMode] = useState(false)

  return (
    <div className="grid grid-2">
      <SheetPanel data={data} state={state} />

      <div>
        <div className="button-row" style={{ marginBottom: 12 }}>
          <button className={gmMode ? 'primary' : ''} onClick={() => setGmMode(!gmMode)}>
            {gmMode ? 'GM 모드 켜짐 — 대화로 진행' : 'GM 모드 (LLM 마스터와 대화로 플레이)'}
          </button>
        </div>
        {gmMode && <GmPanel data={data} rng={rng} state={state} setState={setState} />}
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
              {(() => {
                const has = (id: string) => state.character.inventory.some((i) => i.itemId === id && i.qty > 0)
                const canHunt = state.character.weaponsAtHand.length > 0 || has('snare') || has('bear-trap')
                const canFish = has('fishing-rod') || has('fishing-net')
                return (
                  <>
                    <button disabled={!canHunt} title={canHunt ? undefined : '무기나 덫이 필요하다'}
                      onClick={() => setState(eveningHunt(rng, data, state))}>
                      사냥 (식량 조달)
                    </button>
                    <button disabled={!canFish} title={canFish ? undefined : '낚싯대나 그물이 필요하다'}
                      onClick={() => setState(eveningFish(rng, data, state))}>
                      낚시{canFish && has('fishing-net') ? ' (그물 D6)' : ' (낚싯대 D4)'}
                    </button>
                  </>
                )
              })()}
              {((state.character.damagedWeaponIds ?? []).length > 0 || (state.character.impairedWeaponIds ?? []).length > 0) && (
                <button onClick={() => setState(eveningRepair(rng, data, state))}>
                  무기 손질 (제작 판정)
                </button>
              )}
              <button onClick={() => setState(eveningSkip(rng, data, state))}>
                바로 잔다
              </button>
            </div>
            {state.character.knownSpellIds.length > 0 && (
              <MagicEveningPanel data={data} rng={rng} state={state} setState={setState} />
            )}
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

/** 저녁 마법 활동 — 준비 주문 교체(그리무아, 시프트 소모) + 비전투 시전 */
function MagicEveningPanel({
  data,
  rng,
  state,
  setState,
}: {
  data: ReturnType<typeof loadGameData>
  rng: RNG
  state: GameState
  setState: (s: GameState) => void
}) {
  const c = state.character
  const limit = preparedSpellLimit(data, c)
  const knownSpells = c.knownSpellIds
    .map((id) => data.spells.find((s) => s.id === id)!)
    .filter(Boolean)
  const preparable = knownSpells.filter((s) => s.kind === 'spell')
  const hasGrimoire = c.inventory.some((i) => i.itemId === 'grimoire' && i.qty > 0)

  const [prepOpen, setPrepOpen] = useState(false)
  const [castOpen, setCastOpen] = useState(false)
  const [selection, setSelection] = useState<string[]>(c.preparedSpellIds)

  const toggle = (id: string) =>
    setSelection(selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id])

  return (
    <div style={{ marginTop: 14 }}>
      <h3>마법 (WP {c.wp})</h3>
      <p className="muted">
        준비 주문 {c.preparedSpellIds.length}/{limit} (한도 = 지능 기본치).
        미준비 주문은 그리무아에서 시간 ×2로 시전한다.
      </p>
      <div className="button-row" style={{ marginBottom: 8 }}>
        <button disabled={!hasGrimoire} onClick={() => { setPrepOpen(!prepOpen); setCastOpen(false) }}>
          주문 준비 교체 {hasGrimoire ? '(시프트 소모)' : '(그리무아 없음)'}
        </button>
        <button onClick={() => { setCastOpen(!castOpen); setPrepOpen(false) }}>
          주문 시전 (저녁 소모)
        </button>
      </div>

      {prepOpen && (
        <div className="event-card">
          {preparable.map((s) => (
            <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.9rem', margin: '4px 0' }}>
              <input type="checkbox" checked={selection.includes(s.id)}
                disabled={!selection.includes(s.id) && selection.length >= limit}
                onChange={() => toggle(s.id)} />
              {s.name} <span className="muted">({data.skills.find((k) => k.id === s.school)?.name ?? '일반'} · 위계 {s.rank})</span>
            </label>
          ))}
          <button className="primary" style={{ marginTop: 6 }}
            disabled={selection.length > limit}
            onClick={() => setState(eveningPrepareSpells(rng, data, state, selection))}>
            이 조합으로 준비하고 잔다 ({selection.length}/{limit})
          </button>
        </div>
      )}

      {castOpen && (
        <div className="event-card">
          {knownSpells.map((s) => {
            const prepared = s.kind === 'trick' || c.preparedSpellIds.includes(s.id)
            const grimoireOnly = !prepared
            if (grimoireOnly && (!hasGrimoire || s.castingTime === 'reaction')) return null
            const levels = s.kind === 'trick' ? [0] : s.usesPowerLevel ? [1, 2, 3] : [1]
            return (
              <div key={s.id} className="button-row" style={{ margin: '4px 0' }}>
                {levels.map((pl) => {
                  const cost = s.kind === 'trick' ? 1 : s.usesPowerLevel ? pl * 2 : 2
                  return (
                    <button key={pl} disabled={c.wp < cost}
                      onClick={() => setState(eveningCastSpell(rng, data, state, s.id, Math.max(1, pl)))}>
                      {s.name}{s.usesPowerLevel ? ` 위력${pl}` : ''} ({cost}WP{grimoireOnly ? ' · 그리무아 ×2' : ''})
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
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
