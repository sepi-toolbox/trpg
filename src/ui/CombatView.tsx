import { useState } from 'react'
import { effectiveDefense, isHeroTurn, livingFoes } from '../rules/combat'
import type { CombatState } from '../rules/combat'
import type { Character } from '../rules/types'
import { SKILL_BY_ID } from '../data'

export function CombatView({
  combat,
  character,
  onAttack,
  onSkill,
  onDefend,
  onSettle,
}: {
  combat: CombatState
  character: Character
  onAttack: (targetId: string) => void
  onSkill: (skillId: string, targetId: string) => void
  onDefend: () => void
  onSettle: () => void
}) {
  const alive = livingFoes(combat)
  const [targetId, setTargetId] = useState<string>(alive[0]?.id ?? '')

  const currentTarget = alive.some((f) => f.id === targetId) ? targetId : (alive[0]?.id ?? '')
  const myTurn = isHeroTurn(combat)
  const over = combat.status !== 'ongoing'

  return (
    <section className="panel">
      <h2>전투 — 라운드 {combat.round}</h2>

      <div className="turn-banner">
        {over
          ? combat.status === 'victory'
            ? '전투 종료 — 승리'
            : '전투 종료 — 패배'
          : myTurn
            ? '당신의 차례입니다.'
            : '적이 행동 중…'}
      </div>

      <div style={{ marginBottom: 14 }}>
        {combat.foes.map((foe) => {
          const dead = foe.hp <= 0
          return (
            <button
              key={foe.id}
              className={`foe${dead ? ' dead' : ''}${foe.id === currentTarget && !dead ? ' targeted' : ''}`}
              style={{ width: '100%', textAlign: 'left' }}
              disabled={dead || over}
              onClick={() => setTargetId(foe.id)}
            >
              <div className="foe-head">
                <span className="name">{foe.name}</span>
                <span className="meta">
                  HP {foe.hp}/{foe.maxHp} · 방어 {effectiveDefense(foe)} · 명중 +
                  {foe.attackBonus} · {foe.damage}
                </span>
              </div>
              <div className="bar">
                <span style={{ width: `${(foe.hp / foe.maxHp) * 100}%` }} />
              </div>
            </button>
          )
        })}
      </div>

      {over ? (
        <button className="primary" onClick={onSettle}>
          결과 확인
        </button>
      ) : (
        <>
          <div className="button-row" style={{ marginBottom: 10 }}>
            <button
              className="primary"
              disabled={!myTurn || !currentTarget}
              onClick={() => onAttack(currentTarget)}
            >
              공격
            </button>
            <button disabled={!myTurn} onClick={onDefend}>
              방어 태세 (방어 +2, 1d4 회복)
            </button>
          </div>

          <h3>기술</h3>
          <div className="button-row">
            {character.skills.map((id) => {
              const skill = SKILL_BY_ID[id]
              if (!skill) return null
              const left = combat.skillUses[id] ?? 0
              const target = skill.kind === 'attack' ? currentTarget : 'hero'
              return (
                <button
                  key={id}
                  disabled={!myTurn || left <= 0 || (skill.kind === 'attack' && !currentTarget)}
                  title={skill.description}
                  onClick={() => onSkill(id, target)}
                >
                  {skill.name} ({left})
                </button>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}
