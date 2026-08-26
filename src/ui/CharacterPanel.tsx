import {
  ABILITY_KEYS,
  ABILITY_LABELS,
  abilityModifier,
  attackBonusOf,
  defenseOf,
  proficiencyBonus,
  XP_THRESHOLDS,
} from '../rules'
import type { Character } from '../rules/types'
import { ARMOR_BY_ID, CLASS_BY_ID, SKILL_BY_ID, WEAPON_BY_ID } from '../data'

function signed(n: number) {
  return n >= 0 ? `+${n}` : `${n}`
}

export function CharacterPanel({
  character,
  gold,
  floorName,
  roomIndex,
  roomsTotal,
  skillUses,
}: {
  character: Character
  gold: number
  floorName: string
  roomIndex: number
  roomsTotal: number
  skillUses?: Record<string, number>
}) {
  const cls = CLASS_BY_ID[character.classId]!
  const weapon = WEAPON_BY_ID[character.weaponId]!
  const armor = ARMOR_BY_ID[character.armorId]!

  const nextThreshold = XP_THRESHOLDS[character.level] ?? null
  const prevThreshold = XP_THRESHOLDS[character.level - 1] ?? 0
  const xpPct =
    nextThreshold === null
      ? 100
      : Math.min(
          100,
          ((character.xp - prevThreshold) / (nextThreshold - prevThreshold)) * 100,
        )

  const uses = skillUses ?? character.skillUses

  return (
    <aside className="panel">
      <h2>
        {character.name}{' '}
        <span className="muted">
          Lv.{character.level} {cls.name}
        </span>
      </h2>

      <div className="stat-line">
        <div className="stat-row">
          <span>생명력</span>
          <span className="value">
            {character.hp} / {character.maxHp}
          </span>
        </div>
        <div className="bar">
          <span style={{ width: `${(character.hp / character.maxHp) * 100}%` }} />
        </div>
      </div>

      <div className="stat-line">
        <div className="stat-row">
          <span>경험치</span>
          <span className="value">
            {character.xp}
            {nextThreshold !== null ? ` / ${nextThreshold}` : ' (최대)'}
          </span>
        </div>
        <div className="bar xp">
          <span style={{ width: `${xpPct}%` }} />
        </div>
      </div>

      <div className="ability-grid" style={{ margin: '14px 0' }}>
        {ABILITY_KEYS.map((key) => (
          <div className="ability" key={key}>
            <div className="label">{ABILITY_LABELS[key]}</div>
            <div className="score">{character.abilities[key]}</div>
            <div className="mod">{signed(abilityModifier(character.abilities[key]))}</div>
          </div>
        ))}
      </div>

      <div className="kv">
        <span className="k">방어도</span>
        <span className="v">{defenseOf(character)}</span>
      </div>
      <div className="kv">
        <span className="k">명중 보정</span>
        <span className="v">{signed(attackBonusOf(character))}</span>
      </div>
      <div className="kv">
        <span className="k">숙련 보너스</span>
        <span className="v">{signed(proficiencyBonus(character.level))}</span>
      </div>
      <div className="kv">
        <span className="k">무기</span>
        <span className="v">
          {weapon.name} {weapon.damage}
          {weapon.critRange < 20 ? ` (크리 ${weapon.critRange}+)` : ''}
        </span>
      </div>
      <div className="kv">
        <span className="k">방어구</span>
        <span className="v">{armor.name}</span>
      </div>
      <div className="kv">
        <span className="k">금화</span>
        <span className="v">{gold}</span>
      </div>
      <div className="kv">
        <span className="k">위치</span>
        <span className="v">
          {floorName} {roomIndex}/{roomsTotal}
        </span>
      </div>

      <h3 style={{ marginTop: 16 }}>기술</h3>
      {character.skills.map((id) => {
        const skill = SKILL_BY_ID[id]
        if (!skill) return null
        return (
          <div className="kv" key={id}>
            <span className="k" title={skill.description}>
              {skill.name}
            </span>
            <span className="v">
              {uses[id] ?? 0} / {skill.uses}
            </span>
          </div>
        )
      })}
    </aside>
  )
}
