/**
 * LLM GM — Anthropic API 브라우저 직결 + 도구 루프.
 *
 * 흐름: 플레이어 자유 입력 → LLM 이 의도를 도구 호출로 번역 → 엔진이 판정 →
 *       로그 델타를 tool_result 로 회신 → LLM 이 결과를 서술.
 *
 * API 키는 localStorage 에만 저장된다 (레포·서버에 절대 올라가지 않음).
 * 주의: 게임 로그·상태가 API 로 전송된다. LLM 응답은 비결정적 — 시드 재현성은 GM 모드에선 없다.
 */
import type { RNG } from '../system/rng'
import type { GameData } from '../system/types'
import type { GameState } from '../app/session'
import { buildToolSchema, dispatchTool, serializeState } from './tools'

const API_URL = 'https://api.anthropic.com/v1/messages'
export const DEFAULT_MODEL = 'claude-sonnet-4-5'

export const KEY_STORAGE = 'dbsystem-gm-api-key'
export const MODEL_STORAGE = 'dbsystem-gm-model'

export function loadApiKey(): string {
  try { return localStorage.getItem(KEY_STORAGE) ?? '' } catch { return '' }
}
export function saveApiKey(key: string): void {
  try { localStorage.setItem(KEY_STORAGE, key) } catch { /* ignore */ }
}
export function loadModel(): string {
  try { return localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL } catch { return DEFAULT_MODEL }
}
export function saveModel(model: string): void {
  try { localStorage.setItem(MODEL_STORAGE, model) } catch { /* ignore */ }
}

/* ─────────────────────────── 시스템 프롬프트 ─────────────────────────── */

function systemPrompt(data: GameData, state: GameState): string {
  return [
    '너는 1인용 TRPG 웹게임 "황야의 파수탑"의 게임 마스터(GM)다. 한국어로 진행한다.',
    '',
    '## 절대 규칙',
    '- 판정·피해·수치는 절대 네가 정하지 않는다. 반드시 도구를 호출하고, 돌아온 로그(엔진 결과)만을 사실로 서술한다.',
    '- 도구 결과와 모순되는 서술 금지. 성공/실패·수치를 지어내지 마라.',
    '- 플레이어의 선택을 대신하지 마라. reaction/critical/ambush 프롬프트가 뜨면 선택지를 제시하고 답을 기다린 뒤 resolve_prompt 를 호출한다.',
    '- 전투 중 PC 턴이 아닐 때는 행동 도구를 호출하지 마라 (엔진이 거부한다).',
    '- 원작 룰북의 문장을 인용·복제하지 마라. 서술은 전부 네 창작이어야 한다.',
    '',
    '## 게임의 뼈대',
    '- 시나리오: 옛 파수탑까지 60km 여정 → 수호자 격파. 하루 = 이동 2시프트 + 저녁 활동 + 야간.',
    '- 판정: D20 하향(스킬 레벨 이하 성공). 1 = 용(대성공), 20 = 마(대실패). 상황이 유리/불리하면 skill_check 의 boons/banes(±2 상한)로 반영하고 근거를 말한다.',
    '- 이름이 비어 있는 데이터는 id 로 표시된다 — 서술에서는 어울리는 이름을 지어 불러도 되지만, 도구 호출에는 반드시 id 를 쓴다.',
    '- 데이터에 있는 몬스터/NPC/동물만 등장시킬 수 있다 (begin_combat 이 검증한다).',
    '- 효과 설명에 "(수동 효과)"가 보이면 그 규칙 요약을 네가 재량으로 적용한다 — 판정이 필요하면 skill_check, 소폭 수치 적용은 apply_ruling.',
    '',
    '## 진행 방식',
    '1. 플레이어 입력의 의도를 파악한다 (설득하고 싶다 → persuasion 판정, 검을 뽑는다 → 전투 등).',
    '2. 필요한 도구를 호출한다 (한 입력에 여러 도구 가능 — 예: 판정 후 결과에 따라 전투 개시).',
    '3. 로그를 근거로 장면을 서술한다 (2~5문장, 과장 없이 긴장감 있게). 수치는 자연스럽게 녹인다.',
    '4. 지금 할 수 있는 선택지를 2~4개 제시한다.',
    '',
    '## 현재 상태',
    serializeState(data, state),
  ].join('\n')
}

/* ─────────────────────────── 대화 메시지 ─────────────────────────── */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system-note'
  text: string
}

interface ApiContent {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}
interface ApiMessage { role: 'user' | 'assistant'; content: string | ApiContent[] }

export interface GmTurnResult {
  state: GameState
  messages: ChatMessage[]
  error?: string
}

/**
 * 플레이어 입력 한 번을 처리한다: LLM 호출 → 도구 루프(최대 8회) → 최종 서술.
 * history 는 최근 대화 (토큰 절약을 위해 앞쪽은 잘라서 전달).
 */
export async function runGmTurn(
  rng: RNG,
  data: GameData,
  state: GameState,
  history: ChatMessage[],
  playerInput: string,
): Promise<GmTurnResult> {
  const apiKey = loadApiKey()
  if (!apiKey) return { state, messages: [], error: 'API 키가 없다 — 설정에서 입력해 주세요.' }

  const tools = buildToolSchema(data)
  const newMessages: ChatMessage[] = []
  let s = state

  // 대화 이력 → API 메시지 (최근 20개, system-note 제외)
  const apiMessages: ApiMessage[] = history
    .filter((m) => m.role !== 'system-note')
    .slice(-20)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }))
  apiMessages.push({ role: 'user', content: playerInput })

  for (let iteration = 0; iteration < 8; iteration++) {
    let res: Response
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: loadModel(),
          max_tokens: 1200,
          system: systemPrompt(data, s),
          tools,
          messages: apiMessages,
        }),
      })
    } catch (e) {
      return { state: s, messages: newMessages, error: `네트워크 오류: ${(e as Error).message}` }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { state: s, messages: newMessages, error: `API 오류 ${res.status}: ${body.slice(0, 300)}` }
    }
    const msg = (await res.json()) as { content: ApiContent[]; stop_reason: string }

    // 텍스트 블록 → 채팅에 표시
    for (const block of msg.content) {
      if (block.type === 'text' && block.text?.trim()) {
        newMessages.push({ role: 'assistant', text: block.text })
      }
    }

    if (msg.stop_reason !== 'tool_use') {
      return { state: s, messages: newMessages }
    }

    // 도구 실행 → tool_result 로 회신
    apiMessages.push({ role: 'assistant', content: msg.content })
    const results: ApiContent[] = []
    for (const block of msg.content) {
      if (block.type !== 'tool_use') continue
      const out = dispatchTool(rng, data, s, block.name!, block.input ?? {})
      s = out.state
      newMessages.push({ role: 'system-note', text: `⚙ ${block.name}: ${out.text}` })
      results.push({
        type: 'tool_result',
        tool_use_id: block.id!,
        content: `${out.text}\n\n[현재 상태]\n${serializeState(data, s)}`,
      })
    }
    apiMessages.push({ role: 'user', content: results })
  }

  return { state: s, messages: newMessages, error: '도구 호출이 너무 깊어 중단했다 (8회 상한).' }
}
