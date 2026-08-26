import { useMemo, useState } from 'react'
import type { GameData, AttributeId } from '../system/types'
import { ATTRIBUTES } from '../system/types'
import { createRNG, hashSeed } from '../system/rng'
import { createCharacter, rollAttributeScores, professionSkillIds, professionOf } from '../system/character'
import type { Character, CreationInput } from '../system/character'

const ATTR_LABEL: Record<string, string> = {
  str: '근력', con: '체력', agl: '민첩', int: '지능', wil: '의지', cha: '매력',
}

/** 직업 핵심 능력치 우선 + 체력/민첩 순으로 굴림값을 배분하는 기본 배치 */
function autoAssign(values: number[], keyAttribute: AttributeId): Record<AttributeId, number> {
  const priority: AttributeId[] = [
    keyAttribute,
    ...(['con', 'agl', 'str', 'int', 'wil', 'cha'] as AttributeId[]).filter((a) => a !== keyAttribute),
  ]
  const sorted = [...values].sort((a, b) => b - a)
  const out = {} as Record<AttributeId, number>
  priority.forEach((attr, i) => { out[attr] = sorted[i]! })
  return out
}

/** 술사 기본 시작 주문 — 선택한 유파 기준 자동 선택 (랭크 1 주문 3 + 트릭 3) */
function mageSpellPicks(data: GameData, schoolSkillId: string): string[] {
  const spells = data.spells
    .filter((s) => s.kind === 'spell' && s.rank === 1 && (s.school === schoolSkillId || s.school === 'general'))
    .slice(0, 3)
    .map((s) => s.id)
  const tricks = data.spells
    .filter((s) => s.kind === 'trick' && (s.school === 'general' || s.school === schoolSkillId))
    .slice(0, 3)
    .map((s) => s.id)
  return [...spells, ...tricks]
}

export function CreationView({
  data,
  onStart,
}: {
  data: GameData
  onStart: (character: Character, seed: number) => void
}) {
  const [name, setName] = useState('')
  const [seedText, setSeedText] = useState('')
  const [kinId, setKinId] = useState(data.kin[0]!.id)
  const [professionId, setProfessionId] = useState('fighter')
  const [ageId, setAgeId] = useState<'young' | 'adult' | 'old'>('adult')
  const [rollCount, setRollCount] = useState(0)
  const [traitRoll, setTraitRoll] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const seed = seedText.trim() === '' ? (Date.now() >>> 0) : hashSeed(seedText.trim())
  const profession = professionOf(data, { professionId })
  const isMage = !!profession.startingMagic
  const [chosenVariantId, setChosenVariantId] = useState<string | null>(null)
  const [heroicAbilityId, setHeroicAbilityId] = useState<string | null>(null)
  const variantId = profession.variants
    ? (profession.variants.some((v) => v.id === chosenVariantId) ? chosenVariantId! : profession.variants[0]!.id)
    : undefined

  const attrValues = useMemo(
    () => rollAttributeScores(createRNG(hashSeed(`${seedText}#attrs#${rollCount}`))),
    [seedText, rollCount],
  )
  const attributes = useMemo(
    () => autoAssign(attrValues, profession.keyAttribute),
    [attrValues, profession.keyAttribute],
  )

  const profSkills = professionSkillIds(profession, variantId ?? null)
  const age = data.ageTable.find((a) => a.id === ageId)!
  const freeCount = age.extraTrainedSkills

  // 약점·기념품 (옵션 룰) — D20 굴림, 재굴림 가능
  const traitRng = createRNG(hashSeed(`${seedText}#traits#${traitRoll}`))
  const weaknessId = data.config.weaknesses ? 1 + Math.floor(traitRng.next() * 20) : null
  const mementoId = data.config.mementos ? 1 + Math.floor(traitRng.next() * 20) : null
  const traitName = (tableId: string, n: number | null) => {
    if (n === null) return null
    const row = data.tables.find((t) => t.id === tableId)?.rows.find((r) => n >= r.min && n <= r.max)
    return row?.name || `#${n}`
  }

  // 훈련 스킬: 직업 6종 + 자유 선택
  const [chosenProf, setChosenProf] = useState<string[]>(profSkills.slice(0, 6))
  const [chosenFree, setChosenFree] = useState<string[]>([])

  const freeCandidates = data.skills.filter(
    (s) => s.kind !== 'magic' && !chosenProf.includes(s.id),
  )

  const toggle = (list: string[], set: (v: string[]) => void, id: string, max: number) => {
    if (list.includes(id)) set(list.filter((x) => x !== id))
    else if (list.length < max) set([...list, id])
  }

  const switchProfession = (id: string, nextVariantId?: string) => {
    setProfessionId(id)
    const p = professionOf(data, { professionId: id })
    const v = p.variants ? (nextVariantId ?? p.variants[0]!.id) : null
    setChosenVariantId(v)
    setHeroicAbilityId(p.heroicAbilityIds[0] ?? null)
    const skills = professionSkillIds(p, v)
    setChosenProf(skills.slice(0, 6))
    setChosenFree([])
    setError(null)
  }

  const start = () => {
    try {
      const input: CreationInput = {
        name,
        kinId,
        professionId,
        variantId,
        ageId,
        attributes,
        trainedSkillIds: [...chosenProf, ...chosenFree],
        heroicAbilityId: isMage ? undefined : (heroicAbilityId ?? profession.heroicAbilityIds[0]),
        spellIds: isMage
          ? mageSpellPicks(data, profSkills.find((s) => data.skills.some((k) => k.id === s && k.kind === 'magic'))!)
          : undefined,
        weaknessId,
        mementoId,
      }
      const character = createCharacter(createRNG(seed), data, input)
      onStart(character, seed)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid grid-2">
      <section className="panel">
        <h2>모험가 만들기</h2>

        <div className="field">
          <label htmlFor="name">이름</label>
          <input id="name" type="text" value={name} maxLength={20}
            placeholder="이름 없는 모험가" onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="seed">시드 (비우면 무작위)</label>
          <input id="seed" type="text" value={seedText} maxLength={32}
            placeholder="예: 안개황야" onChange={(e) => setSeedText(e.target.value)} />
        </div>

        <div className="field">
          <label>종족</label>
          <select value={kinId} onChange={(e) => setKinId(e.target.value)}>
            {data.kin.map((k) => (
              <option key={k.id} value={k.id}>{k.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>나이</label>
          <select value={ageId} onChange={(e) => { setAgeId(e.target.value as typeof ageId); setChosenFree([]) }}>
            {data.ageTable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} (자유 스킬 {a.extraTrainedSkills})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>능력치 (4D6 최저 제거 · 직업 우선 자동 배치)</label>
          <div className="ability-grid">
            {ATTRIBUTES.map((key) => (
              <div className="ability" key={key}>
                <div className="label">{ATTR_LABEL[key]}</div>
                <div className="score">{attributes[key]}</div>
              </div>
            ))}
          </div>
          <div className="button-row" style={{ marginTop: 8 }}>
            <button onClick={() => setRollCount((n) => n + 1)}>다시 굴리기</button>
          </div>
        </div>

        {(weaknessId !== null || mementoId !== null) && (
          <div className="field">
            <label>약점 · 기념품 (D20)</label>
            {weaknessId !== null && (
              <div className="kv"><span className="k">약점</span><span className="v">{traitName('weaknesses', weaknessId)}</span></div>
            )}
            {mementoId !== null && (
              <div className="kv"><span className="k">기념품</span><span className="v">{traitName('mementos', mementoId)}</span></div>
            )}
            <div className="button-row" style={{ marginTop: 6 }}>
              <button onClick={() => setTraitRoll((n) => n + 1)}>다시 굴리기</button>
            </div>
          </div>
        )}

        {error && <div className="event-card bad">{error}</div>}
        <button className="primary" style={{ width: '100%' }} onClick={start}>
          황야로 떠난다
        </button>
      </section>

      <div>
        <section className="panel">
          <h2>직업</h2>
          <div className="class-list">
            {data.professions.map((p) => (
              <button key={p.id}
                className={`class-card${p.id === professionId ? ' selected' : ''}`}
                onClick={() => switchProfession(p.id)}>
                <div className="name">{p.name}</div>
                <div className="desc">{p.description}</div>
              </button>
            ))}
          </div>
          {profession.variants && (
            <div style={{ marginTop: 10 }}>
              <h3>유파</h3>
              <div className="button-row">
                {profession.variants.map((v) => (
                  <button key={v.id} className={v.id === variantId ? 'primary' : ''}
                    onClick={() => switchProfession(professionId, v.id)}>
                    {v.name || v.id}
                  </button>
                ))}
              </div>
            </div>
          )}
          {profession.heroicAbilityIds.length > 1 && (
            <div style={{ marginTop: 10 }}>
              <h3>시작 영웅 능력</h3>
              <div className="button-row">
                {profession.heroicAbilityIds.map((id) => {
                  const a = data.abilities.find((x) => x.id === id)
                  return (
                    <button key={id} className={id === (heroicAbilityId ?? profession.heroicAbilityIds[0]) ? 'primary' : ''}
                      title={a?.description}
                      onClick={() => setHeroicAbilityId(id)}>
                      {a?.name || id}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <h2>훈련 스킬</h2>
          <h3>직업 스킬에서 6종</h3>
          <div className="button-row">
            {profSkills.map((id) => {
              const s = data.skills.find((x) => x.id === id)!
              const on = chosenProf.includes(id)
              return (
                <button key={id} className={on ? 'primary' : ''}
                  onClick={() => toggle(chosenProf, setChosenProf, id, 6)}>
                  {s.name}
                </button>
              )
            })}
          </div>
          <h3 style={{ marginTop: 10 }}>자유 선택 {chosenFree.length}/{freeCount}</h3>
          <div className="button-row">
            {freeCandidates.map((s) => {
              const on = chosenFree.includes(s.id)
              return (
                <button key={s.id} className={on ? 'primary' : ''}
                  onClick={() => toggle(chosenFree, setChosenFree, s.id, freeCount)}>
                  {s.name}
                </button>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
