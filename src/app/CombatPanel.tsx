import { useState } from 'react'
import type { GameData, DamageType } from '../system/types'
import type { RNG } from '../system/rng'
import { skillLevelOf, weaponOf } from '../system/combatant'
import { effectiveRange, rangedDistanceState, weaponReach } from '../system/combat'
import type { GameState, EnemyUnit } from './session'
import {
  pcAttack,
  pcDash,
  pcDisarm,
  pcDoubleSlash,
  pcDrawWeapon,
  pcEscapeBind,
  pcFlee,
  pcMarkQuarry,
  pcTwinShot,
  pcGrapple,
  pcGrappleCrush,
  pcPickUpWeapon,
  pcReleaseGrapple,
  pcTopple,
  pcWait,
  pcCastSpell,
  pcActivateAbility,
  pcPass,
  pcSelfRally,
  resolveAmbush,
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
    .filter((w) => w.category !== 'shield' && !c.pc.damagedWeaponIds.includes(w.id)
      && !c.outOfAmmoWeaponIds.includes(w.id))

  const targetUnit = c.enemies.find((e) => e.state.id === currentTarget && !e.state.dead)
  const hasAbility = (id: string) => !!state.character.abilities[id]
  const pcStr = c.pc.attributes?.str ?? null

  /** 무기별 거리 상황 표시 — null 이면 그대로 근접 */
  function attackHint(weaponId: string): string | null {
    if (!targetUnit) return null
    const w = weaponOf(data, weaponId)
    const d = targetUnit.distance
    if (d <= weaponReach(w)) {
      return w.category === 'ranged' ? '근접 사격 (베인)' : null
    }
    const rs = rangedDistanceState(w, pcStr, d)
    if (rs === 'normal') return `사격 ${effectiveRange(w, pcStr)}m`
    if (rs === 'long') return '장거리 (베인)'
    if (w.category === 'ranged') return '사거리 밖'
    return '접근 후 공격'
  }

  /** 손에 있지만 뽑지 않은 무기 (바꿔 들기 후보) */
  const sheathed = c.pc.weaponsAtHand
    .filter((id) => !c.pc.drawnWeaponIds.includes(id))
    .map((id) => weaponOf(data, id))
    .filter((w) => w.category !== 'shield' && !c.pc.damagedWeaponIds.includes(w.id))

  /** 대기(카드 교환) 가능한 뒤 순번 슬롯 */
  const pcSlotIdx = c.order.findIndex((s, i) => s.ownerId === 'pc' && !s.done && i >= c.turnIndex)
  const waitTargets = c.order
    .map((slot, index) => ({ slot, index }))
    .filter(({ slot, index }) => {
      if (pcSlotIdx < 0 || index <= pcSlotIdx || slot.done || slot.ownerId === 'pc') return false
      if (c.order[pcSlotIdx] && slot.card <= c.order[pcSlotIdx]!.card) return false
      const them = c.enemies.find((e) => e.state.id === slot.ownerId)
      if (!them || them.state.dead) return false
      return !(them.kind === 'npc' && them.state.acted)
    })
    .slice(0, 3)

  const attackSpells = state.character.preparedSpellIds
    .map((id) => data.spells.find((s) => s.id === id)!)
    .filter((s) => s.effects.some((e) => e.hook === 'damage' || e.hook === 'heal'))

  const activatable = Object.keys(state.character.abilities)
    .map((id) => data.abilities.find((a) => a.id === id)!)
    .filter((a) => a && a.activation !== 'passive' && a.effects.every((e) => e.hook !== 'manual'))

  return (
    <section className="panel">
      <h2>{c.round === 0 ? '조우 — 개전 전' : `전투 — 라운드 ${c.round}`}</h2>

      {c.order.length > 0 && (
        <div className="turn-banner">
          선제:{' '}
          {c.order.map((s, i) => (
            <span key={i} style={{ opacity: s.done ? 0.35 : 1, marginRight: 6 }}>
              [{s.card}] {s.ownerId === 'pc' ? state.character.name : c.enemies.find((e) => e.state.id === s.ownerId)?.state.name ?? s.ownerId}
            </span>
          ))}
        </div>
      )}

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
                  {` · ${e.distance}m`}
                  {e.kind === 'monster' ? ` · 흉포도 ${e.state.ferocity}` : ''}
                  {e.state.prone ? ' · 넘어짐' : ''}
                  {c.grappledEnemyId === e.state.id ? ' · 붙잡힘' : ''}
                  {e.bound ? (e.bound.sleeping ? ' · 잠듦' : ' · 결박') : ''}
                </span>
              </div>
              <div className="bar"><span style={{ width: `${(hp / maxHp) * 100}%` }} /></div>
            </button>
          )
        })}
      </div>

      {/* 잠입 프롬프트 — 개전 전 */}
      {c.prompt?.kind === 'ambush' && (
        <div className="event-card">
          <p style={{ marginTop: 0 }}>
            <strong>적은 아직 이쪽을 모른다.</strong> 몰래 접근하면(은신 판정) 기습 —
            원하는 선제 카드 + 첫 공격이 암습이 된다. 들키면 통상 개전.
          </p>
          <div className="button-row">
            <button className="primary" onClick={() => setState(resolveAmbush(rng, data, state, 'sneak'))}>
              잠입한다 (은신 판정)
            </button>
            <button onClick={() => setState(resolveAmbush(rng, data, state, 'open'))}>
              정면 돌파
            </button>
          </div>
        </div>
      )}

      {/* 리액션 프롬프트 */}
      {c.prompt?.kind === 'reaction' && (
        <div className="event-card bad">
          <p style={{ marginTop: 0 }}>
            <strong>공격이 날아온다!</strong>{' '}
            {c.prompt.monsterAttack?.description || '리액션을 선택하면 이번 라운드 턴을 소모한다.'}
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
            {c.prompt.canWardSpell && (
              <button onClick={() => setState(resolveReaction(rng, data, state, 'ward'))}>
                {data.spells.find((s) => s.id === (c.prompt as { canWardSpell?: string }).canWardSpell)?.name || '감쇄 주문'} (리액션 — 턴 소모 없음)
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

      {/* PC 결박·경직 — 벗어나기만 가능 */}
      {isPcTurn && !downed && c.pcBind && (
        <div className="event-card bad">
          <p style={{ marginTop: 0 }}>
            <strong>{c.pcBind.name}</strong> — 붙들려 있다. 벗어나야 움직일 수 있다.
            {c.pcBind.damagePerRound ? ` (실패 시 ${c.pcBind.damagePerRound} 피해)` : ''}
          </p>
          <div className="button-row">
            <button className="primary" onClick={() => setState(pcEscapeBind(rng, data, state))}>
              벗어나기 ({c.pcBind.escape.skill ? data.skills.find((k) => k.id === c.pcBind!.escape.skill)?.name ?? c.pcBind.escape.skill : '능력치'} 판정, 액션)
            </button>
            <button onClick={() => setState(pcPass(rng, data, state))}>버틴다</button>
          </div>
        </div>
      )}

      {/* PC 턴 액션 — 붙잡기 유지 중이면 조르기/놓아주기만 */}
      {isPcTurn && !downed && c.grappledEnemyId && (
        <div className="event-card">
          <p style={{ marginTop: 0 }}>
            <strong>{c.enemies.find((e) => e.state.id === c.grappledEnemyId)?.state.name}</strong>
            을(를) 깔아 붙잡고 있다 — 조르기와 놓아주기만 할 수 있다.
          </p>
          <div className="button-row">
            <button className="primary" onClick={() => setState(pcGrappleCrush(rng, data, state))}>
              조르기 (격투, 보온 — 회피·패리 불가)
            </button>
            <button onClick={() => setState(pcReleaseGrapple(rng, data, state))}>
              놓아준다 (자유)
            </button>
          </div>
        </div>
      )}

      {isPcTurn && !downed && !c.grappledEnemyId && !c.pcBind && (
        <>
          <h3>공격{targetUnit ? ` — 목표 ${targetUnit.distance}m` : ''}</h3>
          <div className="button-row" style={{ marginBottom: 8 }}>
            {weapons.flatMap((w) => {
              const hint = attackHint(w.id)
              const level = skillLevelOf(c.pc, w.skillId)
              return (w.damageTypes.length ? w.damageTypes : [null]).map((t) => (
                <button key={`${w.id}-${t}`} className="primary"
                  disabled={!currentTarget || hint === '사거리 밖'}
                  title={`${data.skills.find((s) => s.id === w.skillId)?.name ?? w.skillId} 판정 — ${level} 이하 성공`}
                  onClick={() => setState(pcAttack(rng, data, state, w.id, currentTarget, t))}>
                  {w.name} {w.damage}{t ? ` (${DMG_LABEL[t]})` : ''} · ≤{level}{hint ? ` · ${hint}` : ''}
                </button>
              ))
            })}
          </div>

          {(sheathed.length > 0 || c.pcDroppedWeaponIds.length > 0) && (
            <div className="button-row" style={{ marginBottom: 8 }}>
              {sheathed.map((w) => (
                <button key={w.id} disabled={c.drewWeaponThisRound}
                  onClick={() => setState(pcDrawWeapon(rng, data, state, w.id))}>
                  {w.name} 바꿔 들기 (자유{c.drewWeaponThisRound ? ' — 사용함' : ''})
                </button>
              ))}
              {c.pcDroppedWeaponIds.length > 0 && (
                <button onClick={() => setState(pcPickUpWeapon(rng, data, state))}>
                  떨어진 {weaponOf(data, c.pcDroppedWeaponIds[0]!).name} 줍기 (액션)
                </button>
              )}
            </div>
          )}

          {data.config.specialAttacks && weapons[0] && targetUnit && (
            <>
              <h3>특수 공격</h3>
              <div className="button-row" style={{ marginBottom: 8 }}>
                <button disabled={!currentTarget}
                  onClick={() => setState(pcTopple(rng, data, state, weapons[0]!.id, currentTarget))}>
                  넘어뜨리기
                </button>
                {targetUnit.kind === 'npc' && targetUnit.state.drawnWeaponIds.length > 0 && (
                  <button onClick={() => setState(pcDisarm(rng, data, state, weapons[0]!.id, currentTarget))}>
                    무장 해제
                  </button>
                )}
                {targetUnit.kind === 'npc' && (
                  <button onClick={() => setState(pcGrapple(rng, data, state, currentTarget))}>
                    붙잡기 (격투 대결)
                  </button>
                )}
                {data.config.damageTypes && weapons.some((w) => w.damageTypes.includes('piercing')) && (
                  <button
                    onClick={() => {
                      const w = weapons.find((x) => x.damageTypes.includes('piercing'))!
                      setState(pcAttack(rng, data, state, w.id, currentTarget, 'piercing', 'weakSpot'))
                    }}>
                    약점 찌르기 (베인, 방어구 무시)
                  </button>
                )}
                {hasAbility('twin-shot') && weapons.some((w) => w.skillId === 'bows') && (
                  <button onClick={() => setState(pcTwinShot(rng, data, state, weapons.find((w) => w.skillId === 'bows')!.id, currentTarget))}>
                    쌍발 사격 (베인, 피해 ×2)
                  </button>
                )}
                {hasAbility('double-slash') && weapons.some((w) => w.damageTypes.includes('slashing')) && (
                  <button onClick={() => setState(pcDoubleSlash(rng, data, state, weapons.find((w) => w.damageTypes.includes('slashing'))!.id))}>
                    쌍참격 (두 적)
                  </button>
                )}
                {hasAbility('hunters-mark') && c.markedTargetId !== currentTarget && (
                  <button onClick={() => setState(pcMarkQuarry(rng, data, state, currentTarget))}>
                    사냥감 지정 (액션)
                  </button>
                )}
              </div>
            </>
          )}

          <h3>이동·순서</h3>
          <div className="button-row" style={{ marginBottom: 8 }}>
            <button disabled={!currentTarget || (targetUnit?.distance ?? 0) <= 2}
              onClick={() => setState(pcDash(rng, data, state, 'close', currentTarget))}>
              돌진 (이동 ×2)
            </button>
            <button onClick={() => setState(pcDash(rng, data, state, 'away'))}>
              거리 벌리기 (이동 ×2)
            </button>
            {waitTargets.map(({ index, slot }) => (
              <button key={index} disabled={c.pcWaited}
                onClick={() => setState(pcWait(rng, data, state, index))}>
                대기 — [{slot.card}]번 카드와 교환 ({c.enemies.find((e) => e.state.id === slot.ownerId)?.state.name ?? slot.ownerId})
              </button>
            ))}
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
