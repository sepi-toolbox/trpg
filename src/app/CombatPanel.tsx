import { useState } from 'react'
import type { GameData, DamageType } from '../system/types'
import type { RNG } from '../system/rng'
import { weaponOf } from '../system/combatant'
import type { GameState, EnemyUnit } from './session'
import {
  pcAttack,
  pcFlee,
  pcTopple,
  pcCastSpell,
  pcActivateAbility,
  pcPass,
  pcSelfRally,
  resolveCritical,
  resolveReaction,
} from './session'

const DMG_LABEL: Record<DamageType, string> = {
  slashing: '참격', piercing: '관통', bludgeoning: '타격',
}

function enemyName(e: EnemyUnit): string {
  return e.state.name
}
function enemyHp(e: EnemyUnit): { hp: number; maxHp: number } {
  return { hp: e.state.hp, maxHp: e.state.maxHp }
}
function enemyDead(e: EnemyUnit): boolean {
  return e.state.dead
}

export function CombatPanel({
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
  const c = state.combat!
  const alive = c.enemies.filter((e) => !enemyDead(e))
  const [targetId, setTargetId] = useState(alive[0]?.state.id ?? '')
  const currentTarget = alive.some((e) => e.state.id === targetId)
    ? targetId
    : (alive[0]?.state.id ?? '')

  const slot = c.order[c.turnIndex]
  const isPcTurn = !c.prompt && c.status === 'ongoing' && slot?.ownerId === 'pc' && !slot.done
  const downed = c.pc.hp === 0

  const weapons = c.pc.drawnWeaponIds
    .map((id) => weaponOf(data, id))
    .filter((w) => w.category !== 'shield' && !c.pc.damagedWeaponIds.includes(w.id))

  const attackSpells = state.character.preparedSpellIds
    .map((id) => data.spells.find((s) => s.id === id)!)
    .filter((s) => s.effects.some((e) => e.hook === 'damage' || e.hook === 'heal'))

  const activatable = Object.keys(state.character.abilities)
    .map((id) => data.abilities.find((a) => a.id === id)!)
    .filter((a) => a && a.activation !== 'passive' && a.effects.every((e) => e.hook !== 'manual'))

  return (
    <section className="panel">
      <h2>전투 — 라운드 {c.round}</h2>

      <div className="turn-banner">
        선제:{' '}
        {c.order.map((s, i) => (
          <span key={i} style={{ opacity: s.done ? 0.35 : 1, marginRight: 6 }}>
            [{s.card}] {s.ownerId === 'pc' ? state.character.name : c.enemies.find((e) => e.state.id === s.ownerId)?.state.name ?? s.ownerId}
          </span>
        ))}
      </div>

      <div style={{ marginBottom: 12 }}>
        {c.enemies.map((e) => {
          const { hp, maxHp } = enemyHp(e)
          const dead = enemyDead(e)
          return (
            <button key={e.state.id}
              className={`foe${dead ? ' dead' : ''}${e.state.id === currentTarget && !dead ? ' targeted' : ''}`}
              style={{ width: '100%', textAlign: 'left' }}
              disabled={dead}
              onClick={() => setTargetId(e.state.id)}>
              <div className="foe-head">
                <span className="name">{enemyName(e)}</span>
                <span className="meta">
                  HP {hp}/{maxHp}
                  {e.kind === 'monster' ? ` · 흉포도 ${e.state.ferocity}` : ''}
                  {e.state.prone ? ' · 넘어짐' : ''}
                </span>
              </div>
              <div className="bar"><span style={{ width: `${(hp / maxHp) * 100}%` }} /></div>
            </button>
          )
        })}
      </div>

      {/* 리액션 프롬프트 */}
      {c.prompt?.kind === 'reaction' && (
        <div className="event-card bad">
          <p style={{ marginTop: 0 }}>
            <strong>공격이 날아온다!</strong>{' '}
            {c.prompt.monsterAttack ? c.prompt.monsterAttack.description : '리액션을 선택하면 이번 라운드 턴을 소모한다.'}
          </p>
          <div className="button-row">
            {c.prompt.canDodge && (
              <button className="primary" onClick={() => setState(resolveReaction(rng, data, state, 'dodge'))}>
                회피 (턴 소모)
              </button>
            )}
            {c.prompt.canParry && (
              <button className="primary" onClick={() => setState(resolveReaction(rng, data, state, 'parry'))}>
                패리 (턴 소모)
              </button>
            )}
            <button onClick={() => setState(resolveReaction(rng, data, state, 'none'))}>
              그냥 받아낸다
            </button>
          </div>
        </div>
      )}

      {/* 크리티컬 프롬프트 */}
      {c.prompt?.kind === 'critical' && (
        <div className="event-card good">
          <p style={{ marginTop: 0 }}><strong>크리티컬!</strong> 효과를 선택하세요.</p>
          <div className="button-row">
            {c.prompt.choices.includes('doubleDice') && (
              <button className="primary" onClick={() => setState(resolveCritical(rng, data, state, 'doubleDice'))}>
                피해 주사위 2배
              </button>
            )}
            {c.prompt.choices.includes('extraAttack') && (
              <button onClick={() => setState(resolveCritical(rng, data, state, 'extraAttack'))}>
                추가 공격 기회
              </button>
            )}
            {c.prompt.choices.includes('ignoreArmor') && (
              <button onClick={() => setState(resolveCritical(rng, data, state, 'ignoreArmor'))}>
                방어구 무시
              </button>
            )}
          </div>
        </div>
      )}

      {/* PC 턴 액션 */}
      {isPcTurn && !downed && (
        <>
          <h3>공격</h3>
          <div className="button-row" style={{ marginBottom: 8 }}>
            {weapons.flatMap((w) =>
              (w.damageTypes.length ? w.damageTypes : [null]).map((t) => (
                <button key={`${w.id}-${t}`} className="primary" disabled={!currentTarget}
                  onClick={() => setState(pcAttack(rng, data, state, w.id, currentTarget, t))}>
                  {w.name} {w.damage}{t ? ` (${DMG_LABEL[t]})` : ''}
                </button>
              )),
            )}
            {weapons[0] && (
              <button disabled={!currentTarget}
                onClick={() => setState(pcTopple(rng, data, state, weapons[0]!.id, currentTarget))}>
                넘어뜨리기
              </button>
            )}
          </div>

          {attackSpells.length > 0 && (
            <>
              <h3>주문 (WP {state.character.wp})</h3>
              <div className="button-row" style={{ marginBottom: 8 }}>
                {attackSpells.flatMap((s) =>
                  [1, 2, 3].map((pl) => (
                    <button key={`${s.id}-${pl}`}
                      disabled={state.character.wp < pl * 2}
                      onClick={() =>
                        setState(pcCastSpell(rng, data, state, s.id, pl,
                          s.effects.some((e) => e.hook === 'heal') ? 'self' : currentTarget))
                      }>
                      {s.name} 위력{pl} ({pl * 2}WP)
                    </button>
                  )),
                )}
              </div>
            </>
          )}

          {activatable.length > 0 && (
            <>
              <h3>능력</h3>
              <div className="button-row" style={{ marginBottom: 8 }}>
                {activatable.map((a) => (
                  <button key={a.id} title={a.description}
                    disabled={state.character.wp < (a.wpCost === 'varies' ? 1 : a.wpCost)}
                    onClick={() => setState(pcActivateAbility(rng, data, state, a.id))}>
                    {a.name} ({a.wpCost === 'varies' ? '?' : a.wpCost}WP)
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="button-row">
            <button onClick={() => setState(pcPass(rng, data, state))}>턴 넘기기</button>
            <button className="danger" onClick={() => setState(pcFlee(rng, data, state))}>
              도주 (회피 판정)
            </button>
          </div>
          {c.nextRollBoons > 0 && (
            <p className="muted">다음 공격에 보온 ×{c.nextRollBoons}</p>
          )}
        </>
      )}

      {isPcTurn && downed && (
        <div className="event-card bad">
          <p style={{ marginTop: 0 }}>쓰러져 있다 — 턴마다 죽음 판정이 자동으로 굴러간다.</p>
          <div className="button-row">
            <button onClick={() => setState(pcSelfRally(rng, data, state))}>
              정신 붙들기 (의지, 베인)
            </button>
          </div>
        </div>
      )}

      {!isPcTurn && !c.prompt && c.status === 'ongoing' && (
        <p className="muted">적이 움직이고 있다…</p>
      )}
    </section>
  )
}
