/**
 * UI 스모크 — 생성 → 여정 → 전투 진입까지 실제 브라우저로 클릭해 본다.
 *   node scripts/smoke.mjs   (사전: npm run build, playwright dev-dep)
 */
import { chromium } from 'playwright'
import { preview } from 'vite'

const server = await preview({ preview: { port: 4173 } })
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

try {
  await page.goto('http://localhost:4173/trpg/')
  await page.waitForSelector('h1')

  // 생성
  await page.fill('#name', '스모크')
  await page.fill('#seed', 'smoke-7')
  // 자유 스킬 선택 — "자유 선택 0/N" 다음의 button-row에서 N개 클릭
  const freeHeader = page.locator('h3', { hasText: '자유 선택' })
  const needed = Number(((await freeHeader.textContent()) ?? '').match(/\/(\d+)/)?.[1] ?? '2')
  const freeRow = freeHeader.locator('xpath=following-sibling::div[contains(@class,"button-row")][1]')
  for (let i = 0; i < needed; i++) {
    await freeRow.locator('button').nth(i).click()
  }
  await page.click('button.primary:has-text("황야로 떠난다")')
  const err = await page.locator('.event-card.bad').count()
  if (err) console.log('생성 오류:', await page.locator('.event-card.bad').first().textContent())
  await page.waitForSelector('text=일차', { timeout: 5000 })
  console.log('생성 → 여정 진입 OK')

  // 전투가 나올 때까지 이동 (시드 고정 — 결국 조우하거나 파수탑 도착)
  let inCombat = false
  for (let i = 0; i < 40 && !inCombat; i++) {
    const combat = await page.locator('h2', { hasText: '전투' }).count()
    if (combat > 0) { inCombat = true; break }
    const ambush = await page.locator('text=잠입한다').count()
    if (ambush > 0) { await page.click('button:has-text("정면 돌파")'); continue }
    const travel = page.locator('button.primary', { hasText: /다음 시프트|결전/ })
    const evening = page.locator('button.primary', { hasText: '휴식' })
    if (await travel.count()) await travel.first().click()
    else if (await evening.count()) await evening.first().click()
    else break
    await page.waitForTimeout(120)
  }
  if (!inCombat) throw new Error('40스텝 안에 전투에 도달하지 못함')
  console.log('전투 진입 OK')

  // 새 UI 요소 확인: 거리 표시, 이동·순서 섹션 (프롬프트 처리 후)
  for (let i = 0; i < 10; i++) {
    if (await page.locator('text=그냥 받아낸다').count()) {
      await page.click('button:has-text("그냥 받아낸다")')
      await page.waitForTimeout(100)
    } else break
  }
  const meta = await page.locator('.foe .meta').first().textContent()
  if (!/m/.test(meta ?? '')) throw new Error(`거리 표시 없음: ${meta}`)
  console.log(`거리 표시 OK (${meta?.trim()})`)

  if (await page.locator('h3', { hasText: '이동·순서' }).count()) {
    console.log('이동·순서 섹션 OK')
  }
  await page.screenshot({ path: '/tmp/smoke-combat.png' })

  if (errors.length) throw new Error(`페이지 오류: ${errors.join('\n')}`)
  console.log('스모크 통과')
} finally {
  await browser.close()
  await server.close()
}
