// OMS 송장(택배사+송장번호) 자동 수집 봇
// 발주완료 상태 + 송장 비어있는 주문을 OMS에서 긁어와 채움
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, OMS_USERNAME, OMS_PASSWORD, DRY_RUN } = process.env;
const isDry = DRY_RUN === 'true' || DRY_RUN === true;
const OMS_LOGIN_URL = 'https://dooldool6611.com/auth/login';

for (const [k,v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, OMS_USERNAME, OMS_PASSWORD })) {
  if (!v) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}
fs.mkdirSync('screenshots', { recursive: true });

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function fetchPending() {
  // 송장 아직 없는 주문 — 발주완료(신규) + 발송완료(과거 임포트분도 OMS에 있으면 가져오기 시도)
  const { data, error } = await sb.from('orders').select('*')
    .in('status', ['발주완료', '발송완료'])
    .or('tracking.is.null,tracking.eq.');
  if (error) throw error;
  return data || [];
}

async function updateTracking(id, value) {
  if (isDry) return;
  // shipped_at도 함께 세팅해야 72H 미입금 알람이 기준 시각을 가질 수 있음
  const { error } = await sb.from('orders').update({
    tracking: value,
    status: '발송완료',
    shipped_at: new Date().toISOString()
  }).eq('id', id);
  if (error) throw error;
}

function normTel(t) { return (t||'').replace(/\D/g, ''); }
function normName(n) { return (n||'').replace(/\s+/g, '').trim(); }

async function login(page) {
  console.log('🔐 OMS 로그인...');
  await page.goto(OMS_LOGIN_URL, { waitUntil: 'networkidle' });
  await page.getByPlaceholder(/아이디/).fill(OMS_USERNAME);
  await page.locator('input[type="password"]').fill(OMS_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();
  try {
    await page.waitForURL(u => !u.toString().includes('/auth/login'), { timeout: 15000 });
  } catch {
    await page.screenshot({ path: 'screenshots/01-login-fail.png' });
    throw new Error('로그인 후 페이지 전환 안 됨');
  }
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'screenshots/02-after-login.png' });
  console.log('✅ 로그인 성공');
}

// 판매 관리 페이지에서 송장 정보 긁기
// (구조: 각 행 클릭 → 주문 상세 → "개별 주문 및 배송 상세 내역"의 배송정보 셀)
async function scrapeAllTracking(page) {
  console.log('📋 판매 관리 페이지로 이동...');
  // 좌측 메뉴 "판매 관리" 또는 "주문 확인"
  try {
    await page.locator('a:has-text("판매 관리"), text=판매 관리').first().click({ timeout: 5000 });
  } catch {
    // text 매칭 실패시 URL 직접 이동 시도
    console.log('  메뉴 클릭 실패 → URL 직접 이동');
    const possibles = [
      'https://dooldool6611.com/sales',
      'https://dooldool6611.com/sales-management',
      'https://dooldool6611.com/order-confirm',
    ];
    let ok = false;
    for (const u of possibles) {
      try { await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 8000 }); ok = true; break; } catch {}
    }
    if (!ok) throw new Error('판매관리 페이지 못 찾음 (좌측 메뉴 텍스트·URL 변경 가능성)');
  }
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'screenshots/03-sales-list.png', fullPage: true });

  // 표의 모든 행 — 첫 시도엔 일반 tbody tr, 안 되면 다른 선택자 시도
  let rows = await page.locator('tbody tr').all();
  if (rows.length === 0) {
    rows = await page.locator('table tr').all();
  }
  console.log(`  주문 행 ${rows.length}건 발견`);
  if (rows.length === 0) {
    await page.screenshot({ path: 'screenshots/04-no-rows.png', fullPage: true });
    return [];
  }

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const tag = `row-${i+1}`;
    try {
      // 행 클릭 → 상세 페이지
      await rows[i].click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(800);
      await page.screenshot({ path: `screenshots/${tag}-detail.png`, fullPage: true });

      // 받는사람 이름 + 연락처 + 배송정보 추출
      // "개별 주문 및 배송 상세 내역" 섹션의 내용
      // 셀렉터 추측: 텍스트 기반
      const pageText = await page.locator('body').innerText();
      // 전화번호 패턴 추출
      const telMatch = pageText.match(/010[-\s]?\d{3,4}[-\s]?\d{4}/);
      // 송장 패턴: 택배사 이름 + 숫자 (예: "천일 52641766651")
      const couriers = ['천일','CJ','우체국','한진','롯데','로젠','대한통운','경동'];
      let courier = '', tracking = '';
      for (const c of couriers) {
        const re = new RegExp(c + '\\s*([0-9]{10,15})');
        const m = pageText.match(re);
        if (m) { courier = c; tracking = m[1]; break; }
      }
      if (!tracking) {
        // courier 없이 송장만 — 10자리 이상 숫자 (전화번호 제외)
        const numbers = pageText.match(/\b\d{10,15}\b/g) || [];
        const telDigits = telMatch ? telMatch[0].replace(/\D/g,'') : '';
        const trk = numbers.find(n => n !== telDigits && n.length >= 10);
        if (trk) tracking = trk;
      }
      // 받는사람 — "받는사람" 또는 "수취인" 라벨 옆 추출
      let name = '';
      const nameMatch = pageText.match(/(?:받는\s*사람|수취인)\s*[:：\n]?\s*([가-힣]{2,4})/);
      if (nameMatch) name = nameMatch[1];

      if (name && telMatch) {
        const tel = telMatch[0];
        const trkStr = courier && tracking ? `${courier} ${tracking}` : (tracking || '');
        results.push({ name, tel, tracking: trkStr });
        console.log(`  [${i+1}] ${name} / ${tel} → ${trkStr || '(송장 없음)'}`);
      } else {
        console.log(`  [${i+1}] 정보 추출 실패`);
      }

      // 뒤로 (목록으로)
      await page.goBack().catch(()=>{});
      await page.waitForLoadState('networkidle').catch(()=>{});
      await page.waitForTimeout(500);
      // 행 참조가 stale 됐을 수 있어 재조회
      rows = await page.locator('tbody tr').all();
    } catch(e) {
      console.error(`  행 ${i+1} 처리 중 오류: ${e.message}`);
      await page.screenshot({ path: `screenshots/${tag}-error.png`, fullPage: true }).catch(()=>{});
      try { await page.goBack(); rows = await page.locator('tbody tr').all(); } catch {}
    }
  }
  return results;
}

async function main() {
  console.log(`🤖 송장 수집 봇 시작 (DRY_RUN=${isDry})`);
  const pending = await fetchPending();
  console.log(`📋 송장 수집 대상: ${pending.length}건`);
  if (pending.length === 0) { console.log('대상 없음. 종료.'); return; }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 800 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let matched = 0, missed = 0;
  try {
    await login(page);
    const scraped = await scrapeAllTracking(page);
    console.log(`📦 OMS에서 ${scraped.length}건 송장 정보 추출`);

    // 매칭 (이름 + 전화번호)
    for (const o of pending) {
      const name = normName(o.name);
      const tel = normTel(o.tel);
      const m = scraped.find(s => normTel(s.tel) === tel && normName(s.name).includes(name.slice(0,2)));
      if (m && m.tracking) {
        await updateTracking(o.id, m.tracking);
        matched++;
        console.log(`✅ 매칭+업데이트: ${o.name} → ${m.tracking}`);
      } else {
        missed++;
        console.log(`⏭️  매칭 실패 (아직 송장 미발급?): ${o.name}`);
      }
    }
  } catch(e) {
    console.error('💥 봇 실패:', e.message);
    await page.screenshot({ path: 'screenshots/fatal.png', fullPage: true }).catch(()=>{});
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(`\n📊 결과: 업데이트 ${matched}건 / 미매칭 ${missed}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
