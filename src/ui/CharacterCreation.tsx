import { useMemo, useState } from 'react'
import {
  ABILITY_KEYS,
  ABILITY_LABELS,
  abilityModifier,
  applyClassBonus,
  createRNG,
  hashSeed,
  rollAbilitiesFor,
  standardArrayFor,
} from '../rules'
import type { Abilities } from '../rules/types'
import { CLASSES } from '../data'

function signed(n: number) {
  return n >= 0 ? `+${n}` : `${n}`
}

export function CharacterCreation({
  onStart,
}: {
  onStart: (args: { name: string; classId: string; abilities: Abilities; seed: number }) => void
}) {
  const [name, setName] = useState('')
  const [classId, setClassId] = useState(CLASSES[0]!.id)
  const [seedText, setSeedText] = useState('')
  const [rolled, setRolled] = useState<Abilities | null>(null)
  const [rollCount, setRollCount] = useState(0)

  const cls = CLASSES.find((c) => c.id === classId)!
  // 굴리지 않았으면 클래스에 맞춘 표준 배열을 쓴다.
  const base = rolled ?? standardArrayFor(cls)
  const finalAbilities = useMemo(() => applyClassBonus(base, cls), [base, cls])

  const seed = seedText.trim() === '' ? Date.now() >>> 0 : hashSeed(seedText.trim())

  const reroll = () => {
    // 능력치 굴림도 시드에 묶어 재현 가능하게 한다.
    const rng = createRNG(hashSeed(`${seedText}#${rollCount}`))
    setRolled(rollAbilitiesFor(rng, cls))
    setRollCount((n) => n + 1)
  }

  return (
    <div className="grid grid-2">
      <section className="panel">
        <h2>모험가 만들기</h2>

        <div className="field">
          <label htmlFor="name">이름</label>
          <input
            id="name"
            type="text"
            value={name}
            placeholder="이름 없는 모험가"
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
          />
        </div>

        <div className="field">
          <label htmlFor="seed">시드 (비우면 무작위)</label>
          <input
            id="seed"
            type="text"
            value={seedText}
            placeholder="예: 고블린소굴"
            onChange={(e) => setSeedText(e.target.value)}
            maxLength={32}
          />
          <p className="muted" style={{ marginTop: 6 }}>
            같은 시드 + 같은 선택 = 같은 던전. 규칙 검증이나 밸런스 비교에 쓰세요.
          </p>
        </div>

        <div className="field">
          <label>능력치</label>
          <div className="ability-grid">
            {ABILITY_KEYS.map((key) => (
              <div className="ability" key={key}>
                <div className="label">{ABILITY_LABELS[key]}</div>
                <div className="score">{finalAbilities[key]}</div>
                <div className="mod">{signed(abilityModifier(finalAbilities[key]))}</div>
              </div>
            ))}
          </div>
          <div className="button-row" style={{ marginTop: 10 }}>
            <button onClick={reroll}>4d6 굴리기</button>
            <button onClick={() => setRolled(null)}>표준 배열</button>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>
            굴린 값은 클래스 우선순위(
            {cls.abilityPriority.map((k) => ABILITY_LABELS[k]).join(' → ')})대로 자동 배분되고,
            클래스 보정(
            {Object.entries(cls.abilityBonus)
              .map(([k, v]) => `${ABILITY_LABELS[k as keyof typeof ABILITY_LABELS]} +${v}`)
              .join(', ')}
            )까지 반영된 최종치가 표시됩니다.
          </p>
        </div>

        <button
          className="primary"
          style={{ width: '100%' }}
          onClick={() => onStart({ name, classId, abilities: base, seed })}
        >
          던전으로 내려간다
        </button>
      </section>

      <section className="panel">
        <h2>클래스</h2>
        <div className="class-list">
          {CLASSES.map((c) => (
            <button
              key={c.id}
              className={`class-card${c.id === classId ? ' selected' : ''}`}
              onClick={() => setClassId(c.id)}
            >
              <div className="name">{c.name}</div>
              <div className="desc">{c.description}</div>
              <div className="desc" style={{ marginTop: 6 }}>
                <span className="tag">생명력 {c.hitDie}</span>
                {c.proficiencies.map((p) => (
                  <span className="tag" key={p}>
                    {ABILITY_LABELS[p]} 숙련
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
