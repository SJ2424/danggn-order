// 당근 → OMS 자동 등록 봇 (등록까지만, 일괄주문·결제는 본인이)
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'fs';

// ====== 설정 ======
const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  OMS_USERNAME, OMS_PASSWORD,
  DRY_RUN
} = process.env;

const OMS_LOGIN_URL = 'https://dooldool6611.com/auth/login';
const isDry = DRY_RUN === 'true' || DRY_RUN === true;

// 우리 앱의 (상품 + 색상) → OMS 주문 폼 URL 매핑
// 새 상품/색상 추가될 때 여기 한 줄 추가
const PRODUCT_URLS = {
  '선반랙|화이트': 'https://dooldool6611.com/catalog/order-form/1',
  '선반랙|블랙':   'https://dooldool6611.com/catalog/order-form/2',
  // 카트사이트(GAS) 상품들은 별도 봇에서 처리 예정:
  // '핸드카트|*', '하체마사지기|*', '족욕기|*', '날개없는선풍기|*', '철제선반|*'
};

// ====== 사전 점검 ======
for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, OMS_USERNAME, OMS_PASSWORD })) {
  if (!v) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}

fs.mkdirSync('screenshots', { recursive: true });

// ====== Supabase ======
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function fetchPendingOrders() {
  const { data, error } = await sb
    .from('orders')
    .select('*')
    .eq('status', '접수')
    .order('created_at', { ascending: true });
  if (error) throw error;
  const all = data || [];
  const supported = all.filter(o => PRODUCT_URLS[`${o.product}|${o.color}`]);
  const skipped = all.length - supported.length;
  if (skipped > 0) console.log(`⏭️  지원 안 하는 상품 ${skipped}건 건너뜀`);
  return supported;
}

async function markRegistered(id) {
  if (isDry) return;
  const { error } = await sb.from('orders').update({ status: '발주대기' }).eq('id', id);
  if (error) throw error;
}

// ====== 주소 분리 ======
function splitAddress(addr) {
  if (!addr) return { base: '', detail: '' };
  const a = String(addr).replace(/\s+/g, ' ').trim();
  // 끝의 호/층/동호 패턴
  let m = a.match(/^(.+?)\s+(\d+동\s*\d+호)$/);
  if (m) return { base: m[1].trim(), detail: m[2].replace(/\s+/g,'').trim() };
  m = a.match(/^(.+?)[\s,]+([\d\-]+호)$/);
  if (m) return { base: m[1].trim(), detail: m[2].trim() };
  m = a.match(/^(.+?)[\s,]+(\d+층)$/);
  if (m) return { base: m[1].trim(), detail: m[2].trim() };
  // 콤마 기준
  const i = a.lastIndexOf(',');
  if (i > 0) return { base: a.slice(0, i).trim(), detail: a.slice(i + 1).trim() };
  return { base: a, detail: '' };
}

// ====== OMS 자동화 ======
async function login(page) {
  console.log('🔐 OMS 로그인...');
  await page.goto(OMS_LOGIN_URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: 'screenshots/01-login.png' });

  await page.getByPlaceholder(/아이디/).fill(OMS_USERNAME);
  await page.locator('input[type="password"]').fill(OMS_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();

  // 로그인 페이지를 벗어날 때까지 대기
  try {
    await page.waitForURL(u => !u.toString().includes('/auth/login'), { timeout: 15000 });
  } catch {
    await page.screenshot({ path: 'screenshots/02-login-failed.png' });
    throw new Error('로그인 후 페이지 전환 안 됨 (아이디/비번 확인)');
  }
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'screenshots/03-after-login.png' });
  console.log('✅ 로그인 성공');
}

async function registerOrder(page, order, idx) {
  const tag = `${idx}-${(order.name||'?').replace(/[^가-힣a-z0-9]/gi,'')}`;
  const key = `${order.product}|${order.color}`;
  const url = PRODUCT_URLS[key];

  console.log(`\n📝 [${idx}] ${order.name} / ${order.product} ${order.color} ${order.qty}개`);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `screenshots/${tag}-1-form.png` });

  // 수량: + 버튼 (qty-1)회 클릭
  const qty = Math.max(1, parseInt(order.qty) || 1);
  if (qty > 1) {
    // + 텍스트 또는 +기호 버튼 찾기
    const plusBtn = page.locator('button:has-text("+")').first();
    for (let i = 1; i < qty; i++) {
      await plusBtn.click();
      await page.waitForTimeout(150);
    }
  }

  // 운영폰 별칭
  await page.getByPlaceholder(/갤럭시|운영폰|별칭/).fill(order.phone || '미지정');

  // 거래 플랫폼: 당근 (기본일 가능성 큼)
  try {
    await page.locator('select').first().selectOption({ label: '당근' });
  } catch (e) {
    // 이미 당근이거나 select가 다른 형태면 무시
  }

  // 구매자 ID
  await page.getByPlaceholder(/ID 입력|구매자/).fill(order.nick || '');

  // 받는 사람
  await page.getByPlaceholder(/실명|받는|수령/).fill(order.name || '');

  // 연락처
  await page.getByPlaceholder(/010-?0000|연락처|전화/).fill(order.tel || '');

  // 주소 처리
  const { base, detail } = splitAddress(order.addr);
  console.log(`  주소 분리: [기본] ${base}  [상세] ${detail}`);

  const baseInput = page.getByPlaceholder(/기본 주소/);
  let usedPopup = false;

  if (await baseInput.count() > 0) {
    const disabled = await baseInput.isDisabled().catch(() => false);
    const readonly = await baseInput.getAttribute('readonly').catch(() => null);
    if (!disabled && readonly === null) {
      await baseInput.fill(base);
    } else {
      usedPopup = true;
    }
  } else {
    usedPopup = true;
  }

  if (usedPopup) {
    console.log('  주소 직접 입력 불가 → 주소검색 팝업 시도');
    await page.screenshot({ path: `screenshots/${tag}-2-addr-before.png`, fullPage: true });

    const searchBtn = page.getByRole('button', { name: /주소 검색|주소검색/ });
    await searchBtn.scrollIntoViewIfNeeded();

    // 새창 열림 감지 + 클릭 동시
    const [newPage] = await Promise.all([
      page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
      searchBtn.click()
    ]);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `screenshots/${tag}-2-after-click.png`, fullPage: true });

    // 진단: 페이지 구조 로깅
    const iframeCount = await page.locator('iframe').count();
    const dialogCount = await page.locator('[role="dialog"], .modal, .popup, .layer, [class*="postcode"], [class*="address"]').count();
    const allPages = page.context().pages().length;
    console.log(`  진단: iframe=${iframeCount}, dialog=${dialogCount}, pages=${allPages}, newPage=${newPage?newPage.url():'없음'}`);

    const popup = newPage;
    const iframeEl = iframeCount > 0 ? await page.locator('iframe').first().elementHandle() : null;

    if (popup) {
      try {
        await popup.waitForLoadState('domcontentloaded', { timeout: 5000 });
      } catch {}
      await popup.waitForTimeout(800);
      await popup.screenshot({ path: `screenshots/${tag}-2-popup.png`, fullPage: true }).catch(()=>{});
      await popup.getByPlaceholder(/도로명|지번|건물|주소/).first().fill(base);
      await popup.keyboard.press('Enter');
      await popup.waitForTimeout(1500);
      await popup.screenshot({ path: `screenshots/${tag}-2-popup-results.png`, fullPage: true }).catch(()=>{});
      await popup.locator('li, .result, .list_item').first().click();
    } else if (iframeEl) {
      const frame = await iframeEl.contentFrame();
      if (frame) {
        await frame.getByPlaceholder(/도로명|지번|건물|주소/).first().fill(base);
        await frame.keyboard.press('Enter');
        await frame.waitForTimeout(1500);
        await frame.locator('li, .result, .list_item').first().click();
      }
    } else {
      // 같은 페이지 모달일 가능성 — 더 기다리고 fullPage 캡처
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `screenshots/${tag}-2-modal-fullpage.png`, fullPage: true });
      throw new Error(`주소 팝업/모달 못 찾음 (iframe=${iframeCount}, dialog=${dialogCount}, newPage=${newPage?'있음':'없음'}) — 캡처 확인 필요`);
    }
    await page.waitForTimeout(800);
  }

  // 상세 주소
  await page.getByPlaceholder(/상세 주소/).fill(detail);

  await page.screenshot({ path: `screenshots/${tag}-3-filled.png` });

  // 판매 관리 등록
  if (isDry) {
    console.log('  [DRY RUN] "판매 관리 등록" 클릭 생략');
    return;
  }

  await page.getByRole('button', { name: /판매 관리 등록|등록/ }).click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `screenshots/${tag}-4-after-submit.png` });
  console.log(`✅ 등록 완료`);
}

// ====== 메인 ======
async function main() {
  console.log(`🤖 봇 시작 (DRY_RUN=${isDry})`);

  const orders = await fetchPendingOrders();
  console.log(`📋 등록 대상: ${orders.length}건\n`);
  if (orders.length === 0) {
    console.log('등록할 주문 없음. 종료.');
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 800 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let ok = 0, fail = 0;

  try {
    await login(page);

    for (let i = 0; i < orders.length; i++) {
      try {
        await registerOrder(page, orders[i], i + 1);
        await markRegistered(orders[i].id);
        ok++;
      } catch (e) {
        console.error(`❌ 실패: ${e.message}`);
        try { await page.screenshot({ path: `screenshots/fail-${i+1}.png`, fullPage: true }); } catch {}
        fail++;
      }
    }
  } catch (e) {
    console.error('\n💥 봇 전체 실패:', e.message);
    try { await page.screenshot({ path: 'screenshots/fatal.png', fullPage: true }); } catch {}
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log(`\n📊 결과: 성공 ${ok}건 / 실패 ${fail}건`);
  if (fail > 0 && ok === 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
