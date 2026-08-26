import type { GameData } from '../system/types'
import { ATTRIBUTES } from '../system/types'
import { baseChance, damageBonus, encumbrance, maxHp, maxWp, movementOf } from '../system/character'
import type { GameState } from './session'
import { JOURNEY_TOTAL_KM } from './session'

const ATTR_LABEL: Record<string, string> = {
  str: '근력', con: '체력', agl: '민첩', int: '지능', wil: '의지', cha: '매력',
}

export function SheetPanel({ data, state }: { data: GameData; state: GameState }) {
  const c = state.character
  const mHp = maxHp(data, c)
  const mWp = maxWp(data, c)
  const kin = data.kin.find((k) => k.id === c.kinId)
  const prof = data.professions.find((p) => p.id === c.professionId)

  const trained = c.trainedSkillIds
    .map((id) => data.skills.find((s) => s.id === id))
    .filter(Boolean)
  const enc = encumbrance(data, c)

  return (
    <aside className="panel">
      <h2>
        {c.name}{' '}
        <span className="muted">
          {kin?.name} {prof?.name}
        </span>
      </h2>

      <div className="stat-line">
        <div className="stat-row">
          <span>생명력</span>
          <span className="value">{c.hp} / {mHp}</span>
        </div>
        <div className="bar"><span style={{ width: `${(c.hp / mHp) * 100}%` }} /></div>
      </div>
      <div className="stat-line">
        <div className="stat-row">
          <span>의지력</span>
          <span className="value">{c.wp} / {mWp}</span>
        </div>
        <div className="bar xp"><span style={{ width: `${mWp ? (c.wp / mWp) * 100 : 0}%` }} /></div>
      </div>

      <div className="ability-grid" style={{ margin: '12px 0' }}>
        {ATTRIBUTES.map((key) => (
          <div className="ability" key={key}>
            <div className="label">{ATTR_LABEL[key]}</div>
            <div className="score">{c.attributes[key]}</div>
            <div className="mod">기본 {baseChance(data, c.attributes[key])}</div>
          </div>
        ))}
      </div>

      <div className="kv"><span className="k">이동력</span><span className="v">{movementOf(data, c)}m</span></div>
      <div className="kv">
        <span className="k">피해 보너스</span>
        <span className="v">
          근력 {damageBonus(data, c.attributes.str) ?? '—'} / 민첩 {damageBonus(data, c.attributes.agl) ?? '—'}
        </span>
      </div>
      <div className="kv">
        <span className="k">소지 한도</span>
        <span className="v">{enc.carried}/{enc.limit}{enc.overEncumbered ? ' ⚠ 과적' : ''}</span>
      </div>
      <div className="kv"><span className="k">식량</span><span className="v">{state.rations}{state.famished ? ' (굶주림!)' : ''}</span></div>
      <div className="kv"><span className="k">여정</span><span className="v">{state.kmTraveled}/{JOURNEY_TOTAL_KM}km · {state.day}일차</span></div>
      {c.weaknessId !== null && (
        <div className="kv">
          <span className="k">약점</span>
          <span className="v">
            {data.tables.find((t) => t.id === 'weaknesses')?.rows.find((r) => r.min <= c.weaknessId! && c.weaknessId! <= r.max)?.name || `#${c.weaknessId}`}
          </span>
        </div>
      )}
      {c.mementoId !== null && (
        <div className="kv">
          <span className="k">기념품</span>
          <span className="v">
            {data.tables.find((t) => t.id === 'mementos')?.rows.find((r) => r.min <= c.mementoId! && c.mementoId! <= r.max)?.name || `#${c.mementoId}`}
            {state.mementoUsed ? ' (사용함)' : ''}
          </span>
        </div>
      )}

      {c.conditions.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {c.conditions.map((id) => {
            const cond = data.conditions.find((x) => x.id === id)
            return <span className="tag" key={id}>{cond?.name ?? id}</span>
          })}
        </div>
      )}

      <h3 style={{ marginTop: 14 }}>훈련 스킬</h3>
      {trained.map((s) => (
        <div className="kv" key={s!.id}>
          <span className="k">
            {s!.name}
            {c.advancementMarks.includes(s!.id) ? ' ✦' : ''}
          </span>
          <span className="v">{c.skillLevels[s!.id]}</span>
        </div>
      ))}
      {c.advancementMarks.filter((m) => !c.trainedSkillIds.includes(m)).map((id) => (
        <div className="kv" key={id}>
          <span className="k">{data.skills.find((s) => s.id === id)?.name} ✦</span>
          <span className="v">{c.skillLevels[id] ?? '—'}</span>
        </div>
      ))}
      <p className="muted" style={{ marginTop: 6 }}>✦ = 성장 마크 (모험 종료 시 성장 굴림)</p>
    </aside>
  )
}
