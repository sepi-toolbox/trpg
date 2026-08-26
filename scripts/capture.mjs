/**
 * 실플레이 캡처 하네스 — 두 시나리오(술사/무인)를 실제 클릭으로 진행하며
 * 주요 화면을 /tmp/caps/*.png 로 저장한다. 콘솔·페이지 오류도 수집.
 *   node scripts/capture.mjs
 */
import { chromium } from 'playwright'
import { preview } from 'vite'

const server = await preview({ preview: { port: 4174 } })
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const errors = []

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  await page.goto('http://localhost:4174/trpg/')
  await page.waitForSelector('h1')
  return page
}

let shotSeq = 0
async function shot(page, name) {
  shotSeq++
  await page.screenshot({ path: `/tmp/caps/${String(shotSeq).padStart(2, '0')}-${name}.png`, fullPage: false })
}

async function create(page, { profession, seed, name }) {
  await page.fill('#name', name)
  await page.fill('#seed', seed)
  if (profession === 'mage') {
    await page.click('button.class-card:has-text("술사")')
    await page.waitForTimeout(100)
  }
  const freeHeader = page.locator('h3', { hasText: '자유 선택' })
  const needed = Number(((await freeHeader.textContent()) ?? '').match(/\/(\d+)/)?.[1] ?? '2')
  const freeRow = freeHeader.locator('xpath=following-sibling::div[contains(@class,"button-row")][1]')
  for (let i = 0; i < needed; i++) await freeRow.locator('button').nth(i).click()
  await shot(page, `creation-${profession}`)
  await page.click('button.primary:has-text("황야로 떠난다")')
  await page.waitForTimeout(150)
  if (await page.locator('.event-card.bad').count()) {
    console.log('생성 오류:', await page.locator('.event-card.bad').first().textContent())
  }
}

const has = async (page, sel) => (await page.locator(sel).count()) > 0
const clickIf = async (page, sel) => {
  if (await has(page, sel)) { await page.locator(sel).first().click(); await page.waitForTimeout(100); return true }
  return false
}

/* ── 시나리오 1: 술사 — 마법 패널·잠입·원거리 시전 ── */
async function mageRun() {
  const page = await newPage()
  await create(page, { profession: 'mage', seed: 'cap-mage-3', name: '재빛' })
  await shot(page, 'journey-first')

  let flags = { evening: false, prep: false, cast: false, ambush: false, combatShot: false, reaction: false, spellShot: false }
  for (let step = 0; step < 120; step++) {
    if (await has(page, '.ending')) { await shot(page, 'mage-ending'); break }

    // 잠입 프롬프트
    if (await has(page, 'button:has-text("잠입한다")')) {
      if (!flags.ambush) { await shot(page, 'ambush-prompt'); flags.ambush = true }
      await page.click('button:has-text("잠입한다")')
      await page.waitForTimeout(120)
      await shot(page, 'boss-combat-after-sneak')
      continue
    }
    // 리액션
    if (await has(page, 'button:has-text("그냥 받아낸다")')) {
      if (!flags.reaction) { await shot(page, 'reaction-prompt'); flags.reaction = true }
      await clickIf(page, 'button:has-text("회피 (턴 소모)")') || await page.click('button:has-text("그냥 받아낸다")')
      await page.waitForTimeout(100)
      continue
    }
    // 크리티컬
    if (await has(page, 'button:has-text("피해 주사위 2배")')) {
      await shot(page, 'critical-prompt')
      await page.click('button:has-text("피해 주사위 2배")')
      await page.waitForTimeout(100)
      continue
    }
    // 전투 — 주문 우선, WP 없으면 지팡이
    if (await has(page, 'h2:has-text("전투")')) {
      if (!flags.combatShot) { await shot(page, 'mage-combat'); flags.combatShot = true }
      const spellBtn = page.locator('button:has-text("위력1")').first()
      if (await spellBtn.count() && await spellBtn.isEnabled()) {
        if (!flags.spellShot) { flags.spellShot = true }
        await spellBtn.click()
      } else if (await has(page, 'h3:has-text("공격")')) {
        const atk = page.locator('h3:has-text("공격") + .button-row button.primary').first()
        if (await atk.count() && await atk.isEnabled()) await atk.click()
        else await clickIf(page, 'button:has-text("턴 넘기기")')
      } else {
        await clickIf(page, 'button:has-text("턴 넘기기")')
      }
      await page.waitForTimeout(120)
      continue
    }
    // 저녁 — 마법 패널 캡처 (1회)
    if (await has(page, 'h2:has-text("저녁")')) {
      if (!flags.evening) {
        flags.evening = true
        await shot(page, 'evening')
        if (await has(page, 'button:has-text("주문 준비 교체")')) {
          await page.click('button:has-text("주문 준비 교체")')
          await page.waitForTimeout(100)
          await shot(page, 'evening-prepare-open')
          await page.click('button:has-text("주문 시전 (저녁 소모)")')
          await page.waitForTimeout(100)
          await shot(page, 'evening-cast-open')
          flags.prep = true
        }
      }
      await clickIf(page, 'button.primary:has-text("휴식")') || await clickIf(page, 'button:has-text("바로 잔다")')
      continue
    }
    // 여정
    if (await clickIf(page, 'button.primary:has-text("다음 시프트")')) continue
    if (await clickIf(page, 'button.primary:has-text("결전")') || await clickIf(page, 'button.primary:has-text("파수탑으로")')) continue
    await page.waitForTimeout(150)
  }
  await shot(page, 'mage-final')
  const logText = await page.locator('.log, .log-panel, section:has(h2:has-text("기록"))').first().textContent().catch(() => '')
  console.log('--- 술사 로그 꼬리 ---')
  console.log((logText ?? '').slice(-900))
  await page.close()
}

/* ── 시나리오 2: 무인 — 특수 공격·대기·거리 ── */
async function fighterRun() {
  const page = await newPage()
  await create(page, { profession: 'fighter', seed: 'cap-fight-11', name: '돌턱' })

  let flags = { disarm: false, grapple: false, crushShot: false, wait: false, dash: false, firstCombat: false }
  for (let step = 0; step < 140; step++) {
    if (await has(page, '.ending')) { await shot(page, 'fighter-ending'); break }

    if (await has(page, 'button:has-text("잠입한다")')) {
      await page.click('button:has-text("정면 돌파")')
      await page.waitForTimeout(120)
      continue
    }
    if (await has(page, 'button:has-text("그냥 받아낸다")')) {
      await clickIf(page, 'button:has-text("패리 (턴 소모)")') || await page.click('button:has-text("그냥 받아낸다")')
      await page.waitForTimeout(100)
      continue
    }
    if (await has(page, 'button:has-text("피해 주사위 2배")')) {
      await shot(page, 'fighter-critical')
      await page.click('button:has-text("추가 공격 기회")')
      await page.waitForTimeout(100)
      await shot(page, 'fighter-after-extra-attack')
      continue
    }
    if (await has(page, 'h2:has-text("전투")')) {
      if (!flags.firstCombat) { flags.firstCombat = true; await shot(page, 'fighter-combat-start') }
      // 붙잡기 유지 중 → 조르기
      if (await has(page, 'button:has-text("조르기")')) {
        if (!flags.crushShot) { flags.crushShot = true; await shot(page, 'grapple-hold') }
        await page.click('button:has-text("조르기")')
        await page.waitForTimeout(100)
        continue
      }
      // 대기 버튼이 보이면 1회 캡처·클릭
      if (!flags.wait && await has(page, 'button:has-text("대기 —")')) {
        flags.wait = true
        await shot(page, 'wait-button')
        await page.click('button:has-text("대기 —")')
        await page.waitForTimeout(120)
        continue
      }
      // 무장 해제 → 붙잡기 순서로 한 번씩 시도
      if (!flags.disarm && await has(page, 'button:has-text("무장 해제")')) {
        flags.disarm = true
        await page.click('button:has-text("무장 해제")')
        await page.waitForTimeout(120)
        await shot(page, 'after-disarm')
        continue
      }
      if (!flags.grapple && await has(page, 'button:has-text("붙잡기 (격투 대결)")')) {
        flags.grapple = true
        await page.click('button:has-text("붙잡기 (격투 대결)")')
        await page.waitForTimeout(120)
        await shot(page, 'after-grapple-try')
        continue
      }
      const atk = page.locator('h3:has-text("공격") + .button-row button.primary').first()
      if (await atk.count() && await atk.isEnabled()) { await atk.click(); await page.waitForTimeout(120); continue }
      if (await clickIf(page, 'button:has-text("돌진 (이동 ×2)")')) { if (!flags.dash) { flags.dash = true; await shot(page, 'after-dash') } continue }
      await clickIf(page, 'button:has-text("턴 넘기기")')
      await page.waitForTimeout(100)
      continue
    }
    if (await has(page, 'h2:has-text("저녁")')) {
      await clickIf(page, 'button.primary:has-text("휴식")') || await clickIf(page, 'button:has-text("바로 잔다")')
      continue
    }
    if (await clickIf(page, 'button.primary:has-text("다음 시프트")')) continue
    if (await clickIf(page, 'button.primary:has-text("결전")') || await clickIf(page, 'button.primary:has-text("파수탑으로")')) continue
    await page.waitForTimeout(150)
  }
  await shot(page, 'fighter-final')
  await page.close()
}

/* ── 시나리오 3: 좁은 화면 레이아웃 (모바일 폭) ── */
async function narrowRun() {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
  page.on('pageerror', (e) => errors.push(`[narrow pageerror] ${e}`))
  await page.goto('http://localhost:4174/trpg/')
  await page.waitForSelector('h1')
  await shot(page, 'narrow-creation')
  await create(page, { profession: 'fighter', seed: 'cap-fight-11', name: '좁은' })
  await shot(page, 'narrow-journey')
  for (let step = 0; step < 30; step++) {
    if (await has(page, 'h2:has-text("전투")')) { await shot(page, 'narrow-combat'); break }
    if (await has(page, 'button:has-text("그냥 받아낸다")')) { await shot(page, 'narrow-combat'); break }
    if (await has(page, 'h2:has-text("저녁")')) { await clickIf(page, 'button:has-text("바로 잔다")'); continue }
    if (await clickIf(page, 'button.primary:has-text("다음 시프트")')) continue
    await page.waitForTimeout(120)
  }
  // 가로 스크롤 발생 여부
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  console.log(`좁은 화면 가로 오버플로: ${overflow}px`)
  await page.close()
}

try {
  await mageRun()
  await fighterRun()
  await narrowRun()
} finally {
  console.log('--- 수집된 오류 ---')
  console.log(errors.length ? errors.join('\n') : '(없음)')
  await browser.close()
  await server.close()
}
