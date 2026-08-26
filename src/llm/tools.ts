/**
 * LLM GM 도구 계층 — LLM 은 의도를 도구 호출로 번역할 뿐, 판정·수치는 전부 엔진이 굴린다.
 *
 * 원칙:
 *  - 모든 상태 변경은 이 디스패처를 거친다. LLM 이 직접 수치를 정하는 길은 없다.
 *  - apply_ruling(GM 재량)만 예외적으로 소폭 조정을 허용하되 상한을 걸어 둔다.
 *  - 각 도구 결과 = 실행 후 새로 쌓인 게임 로그 (LLM 이 그걸 보고 서술한다).
 */
import type { RNG } from '../system/rng'
import type { GameData } from '../system/types'
import { rollD20, rollOpposed, conditionBanes } from '../system/roll'
import { markAdvancement, encumbrance, maxHp, maxWp } from '../system/character'
import { NPC_DEFAULT_SKILL, MONSTER_DEFENSE_SKILL } from '../system/combatant'
import type { GameState } from '../app/session'
import {
  beginCombat, travelShift, resolveAmbush, resolveReaction, resolveCritical,
  eveningRest, eveningHunt, eveningFish, eveningRepair, eveningSkip,
  eveningPrepareSpells, eveningCastSpell,
  pcAttack, pcTopple, pcDisarm, pcGrapple, pcGrappleCrush, pcReleaseGrapple,
  pcDash, pcWait, pcDrawWeapon, pcCastSpell, pcActivateAbility, pcSelfRally,
  pcFlee, pcTwinShot, pcDoubleSlash, pcPickUpWeapon, pcEscapeBind, pcMarkQuarry,
  pcPass, runDebrief,
} from '../app/session'

/* ─────────────────────────── 도구 스키마 (Anthropic tools 형식) ─────────────────────────── */

export function buildToolSchema(data: GameData) {
  const skillIds = data.skills.map((s) => s.id)
  return [
    {
      name: 'skill_check',
      description:
        '자유 스킬 판정 (D20 하향). 전투 액션이 아닌 모든 판정 — 설득, 은신, 등반, 지식 등. ' +
        '대결 판정이면 opposed_target 지정 (전투 중인 적 id 또는 "npc"). ' +
        '상황 보정은 근거와 함께 boons/banes (각 0~2).',
      input_schema: {
        type: 'object',
        properties: {
          skill_id: { type: 'string', enum: skillIds, description: '판정할 스킬' },
          boons: { type: 'integer', minimum: 0, maximum: 2, description: '상황 보온' },
          banes: { type: 'integer', minimum: 0, maximum: 2, description: '상황 베인' },
          opposed_target: { type: 'string', description: '대결 상대 — 전투 중인 적 id. 생략하면 단독 판정' },
          opposed_skill_id: { type: 'string', enum: skillIds, description: '상대가 굴리는 스킬 (대결일 때)' },
          reason: { type: 'string', description: '판정 사유 (로그에 남는다)' },
        },
        required: ['skill_id', 'reason'],
      },
    },
    {
      name: 'begin_combat',
      description:
        '전투 개시. 조우를 연출할 때 데이터에 있는 몬스터/NPC/동물을 등장시킨다 (최대 3). ' +
        'PC 가 주도하는 개전이면 ambush_option 으로 잠입 선택지를 준다. ' +
        '설득 가능 여부는 몬스터 데이터의 persuadable 을 따른다 — 전투 전에 skill_check(persuasion)로 회피 가능.',
      input_schema: {
        type: 'object',
        properties: {
          enemies: {
            type: 'array', maxItems: 3,
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['monster', 'npc', 'animal'] },
                id: { type: 'string', description: 'monsters/npcs/animals.json 의 id' },
                distance: { type: 'integer', minimum: 2, maximum: 100 },
              },
              required: ['kind', 'id'],
            },
          },
          ambush_option: { type: 'boolean', description: 'PC 주도 개전 — 잠입 선택 프롬프트' },
          surprise: { type: 'string', enum: ['pc', 'enemies'], description: '기습 (1라운드 카드 선택)' },
        },
        required: ['enemies'],
      },
    },
    {
      name: 'combat_action',
      description:
        'PC 전투 액션. attack(무기 공격)·topple·disarm·grapple·crush(조르기)·release·dash(돌진/후퇴)·' +
        'wait(카드 교환)·draw(무기 바꿔 들기)·pickup(떨어진 무기)·escape(결박 벗어나기)·mark(사냥감 지정)·' +
        'twinshot·doubleslash·rally(자기 소생)·flee(도주)·pass. PC 턴일 때만.',
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['attack', 'weakspot', 'topple', 'disarm', 'grapple', 'crush', 'release', 'dash',
                   'wait', 'draw', 'pickup', 'escape', 'mark', 'twinshot', 'doubleslash', 'rally', 'flee', 'pass'],
          },
          weapon_id: { type: 'string', description: '무기 id (attack/topple/disarm/draw/twinshot/doubleslash)' },
          target_id: { type: 'string', description: '대상 적 id' },
          damage_type: { type: 'string', enum: ['slashing', 'piercing', 'bludgeoning'] },
          direction: { type: 'string', enum: ['close', 'away'], description: 'dash 방향' },
          wait_slot: { type: 'integer', description: 'wait — 교환할 선제 슬롯 index' },
        },
        required: ['action'],
      },
    },
    {
      name: 'cast_spell',
      description: '주문 시전. 전투 중이면 전투 시전, 저녁이면 비전투 시전(미준비 주문은 그리무아 ×2).',
      input_schema: {
        type: 'object',
        properties: {
          spell_id: { type: 'string' },
          power_level: { type: 'integer', minimum: 1, maximum: 3 },
          target_id: { type: 'string', description: '적 id 또는 "self"' },
        },
        required: ['spell_id'],
      },
    },
    {
      name: 'use_ability',
      description: '영웅 능력 발동 (WP 소모). 광전사·악사·이중 시전 등.',
      input_schema: {
        type: 'object',
        properties: { ability_id: { type: 'string' } },
        required: ['ability_id'],
      },
    },
    {
      name: 'resolve_prompt',
      description:
        '대기 중인 프롬프트 응답. reaction: dodge/parry/ward/none · critical: doubleDice/extraAttack/ignoreArmor · ' +
        'ambush: sneak/open. 반드시 플레이어의 선택을 물어본 뒤 호출할 것 (임의 결정 금지).',
      input_schema: {
        type: 'object',
        properties: { choice: { type: 'string' } },
        required: ['choice'],
      },
    },
    {
      name: 'travel',
      description: '여정 시프트 이동 (길찾기 판정·조우·사고 자동). forced=강행군(탈진).',
      input_schema: {
        type: 'object',
        properties: { forced: { type: 'boolean' } },
      },
    },
    {
      name: 'evening_action',
      description: '저녁 활동 (하나만, 이후 야간 자동 진행): rest/hunt/fish/repair/skip/prepare_spells.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['rest', 'hunt', 'fish', 'repair', 'skip', 'prepare_spells'] },
          spell_ids: { type: 'array', items: { type: 'string' }, description: 'prepare_spells 전용' },
        },
        required: ['action'],
      },
    },
    {
      name: 'apply_ruling',
      description:
        'GM 재량 — manual 효과(description 에 규칙 요약)나 도구로 표현 안 되는 상황의 소폭 기계 적용. ' +
        '상한: HP/WP ±5, 은화 ±20, 식량 ±3. 아이템 지급/회수는 데이터 id 만. 남용 금지 — 판정은 skill_check 로.',
      input_schema: {
        type: 'object',
        properties: {
          hp_delta: { type: 'integer', minimum: -5, maximum: 5 },
          wp_delta: { type: 'integer', minimum: -5, maximum: 5 },
          silver_delta: { type: 'integer', minimum: -20, maximum: 20 },
          rations_delta: { type: 'integer', minimum: -3, maximum: 3 },
          give_item_id: { type: 'string', description: 'weapons/armor/items 의 id' },
          remove_item_id: { type: 'string' },
          note: { type: 'string', description: '적용 사유 (로그에 남는다)' },
        },
        required: ['note'],
      },
    },
    {
      name: 'end_adventure',
      description: '모험 정산 (클리어/사망 화면에서만). 세션 질문에 예라고 답한 수만큼 추가 성장 마크.',
      input_schema: {
        type: 'object',
        properties: {
          extra_mark_skill_ids: { type: 'array', items: { type: 'string', enum: skillIds } },
        },
      },
    },
  ]
}

/* ─────────────────────────── 상태 직렬화 (LLM 컨텍스트용) ─────────────────────────── */

export function serializeState(data: GameData, state: GameState): string {
  const c = state.character
  const out: Record<string, unknown> = {
    screen: state.screen,
    day: state.day,
    km: `${state.kmTraveled}/60`,
    rations: state.rations,
    character: {
      name: c.name,
      hp: `${c.hp}/${maxHp(data, c)}`,
      wp: `${c.wp}/${maxWp(data, c)}`,
      conditions: c.conditions,
      weapons: c.weaponsAtHand,
      damaged: c.damagedWeaponIds ?? [],
      impaired: c.impairedWeaponIds ?? [],
      preparedSpells: c.preparedSpellIds,
      knownSpells: c.knownSpellIds,
      abilities: Object.keys(c.abilities),
      skills: Object.fromEntries(Object.entries(c.skillLevels).filter(([, v]) => v >= 8)),
      encumbrance: encumbrance(data, c),
      inventory: c.inventory.map((i) => `${i.itemId}×${i.qty}`),
      silver: c.silver,
    },
    curses: state.curses.map((x) => x.name),
    chilled: state.chilled,
  }
  const cb = state.combat
  if (cb && state.screen === 'combat') {
    out['combat'] = {
      round: cb.round,
      order: cb.order.map((s2) => `[${s2.card}]${s2.ownerId}${s2.done ? '✓' : ''}`),
      turn: cb.order[cb.turnIndex]?.ownerId ?? null,
      prompt: cb.prompt
        ? cb.prompt.kind === 'reaction'
          ? { kind: 'reaction', canDodge: cb.prompt.canDodge, canParry: cb.prompt.canParry, canWard: !!cb.prompt.canWardSpell }
          : { kind: cb.prompt.kind }
        : null,
      pc: {
        hp: cb.pc.hp, drawn: cb.pc.drawnWeaponIds, prone: cb.pc.prone,
        bind: cb.pcBind?.name ?? null, berserk: cb.pcBerserk,
        dropped: cb.pcDroppedWeaponIds, grappling: cb.grappledEnemyId,
      },
      enemies: cb.enemies.map((e) => ({
        id: e.state.id,
        name: e.state.name,
        hp: `${e.state.hp}/${e.state.maxHp}`,
        distance: e.distance,
        dead: e.state.dead,
        prone: e.state.prone,
        bound: e.bound?.name ?? null,
        persuadable: e.kind === 'monster'
          ? data.monsters.find((m) => m.id === e.state.monsterId)?.persuadable ?? false
          : true,
      })),
    }
  }
  return JSON.stringify(out)
}

/* ─────────────────────────── 디스패처 ─────────────────────────── */

export interface ToolResult {
  state: GameState
  /** LLM 에게 돌려줄 결과 텍스트 (실행 후 쌓인 로그 델타 + 오류) */
  text: string
}

function logDelta(before: GameState, after: GameState): string {
  const lines = after.log.slice(before.log.length).map((l) => l.text)
  return lines.length ? lines.join('\n') : '(변화 없음 — 지금 상태에서 할 수 없는 행동일 수 있다)'
}

export function dispatchTool(
  rng: RNG,
  data: GameData,
  state: GameState,
  name: string,
  input: Record<string, unknown>,
): ToolResult {
  const before = state
  try {
    const after = run(rng, data, state, name, input)
    return { state: after, text: logDelta(before, after) }
  } catch (e) {
    return { state: before, text: `오류: ${(e as Error).message}` }
  }
}

function run(rng: RNG, data: GameData, s: GameState, name: string, input: Record<string, unknown>): GameState {
  const str = (k: string) => input[k] as string | undefined
  const num = (k: string) => (input[k] === undefined ? undefined : Number(input[k]))

  switch (name) {
    case 'skill_check':
      return gmSkillCheck(rng, data, s, input)

    case 'begin_combat': {
      if (s.combat && s.screen === 'combat') throw new Error('이미 전투 중')
      const enemies = (input['enemies'] as { kind: string; id: string; distance?: number }[]).slice(0, 3)
      for (const e of enemies) {
        const pool = e.kind === 'monster' ? data.monsters : e.kind === 'animal' ? data.animals : data.npcs
        if (!pool.some((x: { id: string }) => x.id === e.id)) throw new Error(`없는 ${e.kind}: ${e.id}`)
      }
      const specs = enemies.map((e) => ({
        npcOrMonster: (e.kind === 'monster' ? 'monster' : e.kind === 'animal' ? 'animal' : 'npc') as 'monster' | 'npc' | 'animal',
        id: e.id,
        distance: e.distance ?? 4,
      }))
      return beginCombat(rng, data, s, specs as Parameters<typeof beginCombat>[3], {
        ambushOption: input['ambush_option'] === true,
        surprise: (input['surprise'] as 'pc' | 'enemies' | undefined) ?? null,
      })
    }

    case 'combat_action': {
      const a = str('action')!
      const w = str('weapon_id') ?? s.combat?.pc.drawnWeaponIds[0] ?? ''
      const t = str('target_id') ?? s.combat?.enemies.find((e) => !e.state.dead)?.state.id ?? ''
      const dt = (str('damage_type') ?? null) as 'slashing' | 'piercing' | 'bludgeoning' | null
      switch (a) {
        case 'attack': return pcAttack(rng, data, s, w, t, dt)
        case 'weakspot': return pcAttack(rng, data, s, w, t, 'piercing', 'weakSpot')
        case 'topple': return pcTopple(rng, data, s, w, t)
        case 'disarm': return pcDisarm(rng, data, s, w, t)
        case 'grapple': return pcGrapple(rng, data, s, t)
        case 'crush': return pcGrappleCrush(rng, data, s)
        case 'release': return pcReleaseGrapple(rng, data, s)
        case 'dash': return pcDash(rng, data, s, (str('direction') ?? 'close') as 'close' | 'away', t)
        case 'wait': return pcWait(rng, data, s, num('wait_slot') ?? 0)
        case 'draw': return pcDrawWeapon(rng, data, s, w)
        case 'pickup': return pcPickUpWeapon(rng, data, s)
        case 'escape': return pcEscapeBind(rng, data, s)
        case 'mark': return pcMarkQuarry(rng, data, s, t)
        case 'twinshot': return pcTwinShot(rng, data, s, w, t)
        case 'doubleslash': return pcDoubleSlash(rng, data, s, w)
        case 'rally': return pcSelfRally(rng, data, s)
        case 'flee': return pcFlee(rng, data, s)
        case 'pass': return pcPass(rng, data, s)
        default: throw new Error(`알 수 없는 액션: ${a}`)
      }
    }

    case 'cast_spell': {
      const spellId = str('spell_id')!
      const pl = num('power_level') ?? 1
      const target = str('target_id') ?? 'self'
      if (s.screen === 'combat') return pcCastSpell(rng, data, s, spellId, pl, target)
      if (s.screen === 'evening') return eveningCastSpell(rng, data, s, spellId, pl)
      throw new Error('주문은 전투 중이거나 저녁에만')
    }

    case 'use_ability':
      return pcActivateAbility(rng, data, s, str('ability_id')!)

    case 'resolve_prompt': {
      const choice = str('choice')!
      const prompt = s.combat?.prompt
      if (!prompt) throw new Error('대기 중인 프롬프트 없음')
      if (prompt.kind === 'reaction') return resolveReaction(rng, data, s, choice as 'dodge' | 'parry' | 'ward' | 'none')
      if (prompt.kind === 'critical') return resolveCritical(rng, data, s, choice as 'doubleDice' | 'extraAttack' | 'ignoreArmor')
      return resolveAmbush(rng, data, s, choice as 'sneak' | 'open')
    }

    case 'travel':
      return travelShift(rng, data, s, input['forced'] === true)

    case 'evening_action': {
      const a = str('action')!
      switch (a) {
        case 'rest': return eveningRest(rng, data, s)
        case 'hunt': return eveningHunt(rng, data, s)
        case 'fish': return eveningFish(rng, data, s)
        case 'repair': return eveningRepair(rng, data, s)
        case 'skip': return eveningSkip(rng, data, s)
        case 'prepare_spells': return eveningPrepareSpells(rng, data, s, (input['spell_ids'] as string[]) ?? [])
        default: throw new Error(`알 수 없는 저녁 활동: ${a}`)
      }
    }

    case 'apply_ruling':
      return applyRuling(data, s, input)

    case 'end_adventure': {
      if (s.screen !== 'cleared' && s.screen !== 'dead') throw new Error('모험이 끝난 뒤에만')
      return runDebrief(rng, s, (input['extra_mark_skill_ids'] as string[]) ?? [])
    }

    default:
      throw new Error(`알 수 없는 도구: ${name}`)
  }
}

/* ─────────────────────────── 자유 판정 ─────────────────────────── */

function pushLog(state: GameState, kind: 'good' | 'bad' | 'info' | 'combat', text: string): GameState {
  const id = state.logSeq + 1
  return { ...state, logSeq: id, log: [...state.log, { id, kind, text }] }
}

function gmSkillCheck(rng: RNG, data: GameData, s: GameState, input: Record<string, unknown>): GameState {
  const skillId = input['skill_id'] as string
  const skill = data.skills.find((x) => x.id === skillId)
  if (!skill) throw new Error(`없는 스킬: ${skillId}`)
  const boons = Math.min(2, Math.max(0, Number(input['boons'] ?? 0)))
  const banes = Math.min(2, Math.max(0, Number(input['banes'] ?? 0)))
  const level = s.character.skillLevels[skillId] ?? 0
  const condBanes = conditionBanes(new Set(s.character.conditions), skill.attribute)
  const reason = String(input['reason'] ?? '')

  const targetId = input['opposed_target'] as string | undefined
  let out = s

  if (targetId) {
    // 대결 판정 — 전투 중인 적 또는 일반 NPC(기본치 5)
    const enemy = s.combat?.enemies.find((e) => e.state.id === targetId && !e.state.dead)
    // 설득류는 몬스터 persuadable 검사
    if (enemy?.kind === 'monster' && (skillId === 'persuasion' || skillId === 'bartering' || skillId === 'bluffing')) {
      const def = data.monsters.find((m) => m.id === enemy.state.monsterId)
      if (def && !def.persuadable) {
        return pushLog(s, 'info', `${enemy.state.name}에게는 말이 통하지 않는다. (설득 불가 몬스터)`)
      }
    }
    const oppSkillId = (input['opposed_skill_id'] as string | undefined) ?? skillId
    const oppLevel = enemy
      ? enemy.kind === 'monster'
        ? MONSTER_DEFENSE_SKILL
        : (enemy.state.skills[oppSkillId] ?? NPC_DEFAULT_SKILL)
      : NPC_DEFAULT_SKILL
    const result = rollOpposed(rng, level, oppLevel, { boons, banes: banes + condBanes }, {})
    if (result.active.dragon || result.active.demon) {
      out = { ...out, character: markAdvancement(out.character, skillId) }
    }
    return pushLog(out, result.success ? 'good' : 'bad',
      `판정: ${skill.name || skillId} 대결 (${reason}) — ${result.active.natural} vs ${result.opposing.natural} → ${result.success ? '성공' : '실패'}${result.active.dragon ? ' [용!]' : ''}${result.active.demon ? ' [마!]' : ''}`)
  }

  const result = rollD20(rng, level, { boons, banes: banes + condBanes })
  if (result.dragon || result.demon) {
    out = { ...out, character: markAdvancement(out.character, skillId) }
  }
  return pushLog(out, result.success ? 'good' : 'bad',
    `판정: ${skill.name || skillId} ≤${level} (${reason}) — ${result.natural} → ${result.success ? '성공' : '실패'}${result.dragon ? ' [용!]' : ''}${result.demon ? ' [마!]' : ''}`)
}

/* ─────────────────────────── GM 재량 (상한부) ─────────────────────────── */

function applyRuling(data: GameData, s: GameState, input: Record<string, unknown>): GameState {
  let out = s
  const note = String(input['note'] ?? 'GM 재량')
  const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v ?? 0)))

  const hpDelta = clamp(input['hp_delta'], -5, 5)
  if (hpDelta !== 0) {
    const hp = Math.max(0, Math.min(maxHp(data, out.character), out.character.hp + hpDelta))
    out = { ...out, character: { ...out.character, hp } }
    if (out.combat) out = { ...out, combat: { ...out.combat, pc: { ...out.combat.pc, hp } } }
  }
  const wpDelta = clamp(input['wp_delta'], -5, 5)
  if (wpDelta !== 0) {
    const wp = Math.max(0, Math.min(maxWp(data, out.character), out.character.wp + wpDelta))
    out = { ...out, character: { ...out.character, wp } }
  }
  const silverDelta = clamp(input['silver_delta'], -20, 20)
  if (silverDelta !== 0) {
    out = { ...out, character: { ...out.character, silver: Math.max(0, out.character.silver + silverDelta) } }
  }
  const rationsDelta = clamp(input['rations_delta'], -3, 3)
  if (rationsDelta !== 0) {
    out = { ...out, rations: Math.max(0, out.rations + rationsDelta) }
  }
  const give = input['give_item_id'] as string | undefined
  if (give) {
    const exists = data.items.some((x) => x.id === give) || data.weapons.some((x) => x.id === give) || data.armor.some((x) => x.id === give)
    if (!exists) throw new Error(`없는 아이템: ${give}`)
    const inv = [...out.character.inventory]
    const entry = inv.find((i) => i.itemId === give)
    if (entry) entry.qty += 1
    else inv.push({ itemId: give, qty: 1 })
    out = { ...out, character: { ...out.character, inventory: inv } }
  }
  const remove = input['remove_item_id'] as string | undefined
  if (remove) {
    out = {
      ...out,
      character: {
        ...out.character,
        inventory: out.character.inventory
          .map((i) => (i.itemId === remove ? { ...i, qty: i.qty - 1 } : i))
          .filter((i) => i.qty > 0),
      },
    }
  }
  const parts = [
    hpDelta ? `HP ${hpDelta > 0 ? '+' : ''}${hpDelta}` : '',
    wpDelta ? `WP ${wpDelta > 0 ? '+' : ''}${wpDelta}` : '',
    silverDelta ? `은화 ${silverDelta > 0 ? '+' : ''}${silverDelta}` : '',
    rationsDelta ? `식량 ${rationsDelta > 0 ? '+' : ''}${rationsDelta}` : '',
    give ? `획득 ${give}` : '',
    remove ? `상실 ${remove}` : '',
  ].filter(Boolean).join(', ')
  return pushLog(out, 'info', `(GM 재량) ${note}${parts ? ` — ${parts}` : ''}`)
}
