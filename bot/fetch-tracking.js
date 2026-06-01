// OMS 송장(택배사+송장번호) 자동 수집 봇
// 발주완료 상태 + 송장 비어있는 주문을 OMS에서 긁어와 채움
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'fs';
import { isCartProduct } from './cart-products.js';

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
  // 처리 대상 — 발주완료/발송완료 중:
  //   ① 송장 없는 것 (송장 수집 대상)
  //   ② 발주완료인데 아직 결제 확인 안 된 것 (oms_paid=false — 결제 확인 대상)
  // 제외: 직거래(OMS 대상 아님) + 카트 상품(dooldool6611엔 없음 → 찾아도 매칭 실패, 헛수고·로그오염).
  //   카트 상품의 송장·결제는 카트송장봇(fetch-cart-tracking)·수동 결제체크가 담당.
  const { data, error } = await sb.from('orders').select('*')
    .in('status', ['발주완료', '발송완료']);
  if (error) throw error;
  return (data || []).filter(o =>
    o.type !== '직거래' && !isCartProduct(o.product) && (
      !o.tracking ||                                 // 송장 없음
      (o.status === '발주완료' && !o.oms_paid)        // 미결제 (결제 확인 필요)
    )
  );
}

// 한 주문 캐시 — shipped_at 보존 결정용
async function updateTracking(id, value, currentOrder) {
  if (isDry) return;
  // shipped_at은 이미 있으면 보존 (미입금 7일 카운터 리셋 방지) — 없으면 지금 시각으로 세팅
  const updates = {
    tracking: value,
    status: '발송완료',
    bot_note: null  // 송장 들어왔으면 옛 봇 에러 메시지 클리어
  };
  if (!currentOrder?.shipped_at) {
    updates.shipped_at = new Date().toISOString();
  }
  // 원자적 업데이트 — 송장·상태·oms_paid를 한 번에 (예전엔 2-스텝이라 부분실패 시 "발송완료인데 미결제" 모순)
  // 💳 송장 = 결제+출고 증거 → OMS 결제완료 자동 처리 (수동 체크 깜빡해도 보정)
  const { error } = await sb.from('orders').update({ ...updates, oms_paid: true }).eq('id', id);
  if (error) {
    // oms_paid 컬럼 없는 환경 → 송장·상태만이라도 반드시 넘긴다
    const { error: e2 } = await sb.from('orders').update(updates).eq('id', id);
    if (e2) throw e2;
    console.warn(`⚠️ oms_paid 동시처리 실패 (id=${id}): ${error.message} — oms_paid 컬럼 확인 필요 (alter table public.orders add column if not exists oms_paid boolean not null default false)`);
  }
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
  // 좌측 사이드바 메뉴 후보들 — OMS 페이지마다 텍스트 다를 수 있어서 여러 개 시도
  const menuCandidates = [
    '주문 확인', '주문확인', '주문 내역', '주문내역',
    '판매 관리', '판매관리', '판매 내역', '판매내역',
    '거래 명세서', '거래명세서', '출고 관리', '출고관리',
    '배송 관리', '배송관리', '발송 관리', '발송관리',
    '주문 관리', '주문관리'
  ];
  let clicked = false;
  for (const txt of menuCandidates) {
    try {
      const loc = page.locator(`a:has-text("${txt}"), nav button:has-text("${txt}"), [role="menuitem"]:has-text("${txt}")`).first();
      if (await loc.count() > 0) {
        await loc.click({ timeout: 3000 });
        clicked = true;
        console.log(`  ✅ 메뉴 "${txt}" 클릭`);
        break;
      }
    } catch {}
  }
  if (!clicked) {
    // 사이드바 링크 텍스트 전부 출력 — 디버깅용
    const allLinks = await page.locator('a, [role="menuitem"]').allTextContents();
    const menus = allLinks.map(s=>s.trim()).filter(s=>s && s.length<30 && s.length>1);
    const uniq = [...new Set(menus)];
    console.log('  ⚠️  메뉴 매칭 실패. 페이지에서 발견된 클릭가능 텍스트 (앞 40개):');
    uniq.slice(0,40).forEach(t => console.log(`     - "${t}"`));
    // 현재 페이지 URL도 로그 (이걸로 정확한 URL 패턴 추정 가능)
    console.log(`  현재 URL: ${page.url()}`);
    await page.screenshot({ path: 'screenshots/03-menu-debug.png', fullPage: true });
    throw new Error('판매관리 메뉴 못 찾음 — 위 로그의 텍스트 목록에서 정확한 메뉴명 알려주세요');
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

      // "개별 주문 및 배송 상세 내역" 섹션을 스크롤하고 그 안의 표만 파싱
      // (한 OMS 주문 = N개 개별 배송 묶음 — 각 행이 다른 수취인+송장)
      const sectionHeader = page.locator('text=개별 주문 및 배송 상세 내역').first();
      try {
        await sectionHeader.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.waitForTimeout(600);
      } catch {}
      await page.screenshot({ path: `screenshots/${tag}-detail.png`, fullPage: true });

      // 💳 결제상태 읽기 — 이 입금건이 결제됐는지 (입금완료(자동) / 입금완료(수동) / 미입금)
      //    입금건 단위라, 이 상세의 모든 개별 수취인에게 동일 적용
      const detailText = await page.locator('body').innerText().catch(() => '');
      const isPaid = /입금완료\s*\(\s*(자동|수동)\s*\)/.test(detailText);
      console.log(`  [${i+1}] 결제상태: ${isPaid ? '✅ 입금완료' : '⏳ 미입금'}`);

      // 그 섹션 바로 뒤 표 잡기 (xpath: 형제 중 첫 table)
      const detailRows = await page.locator(
        'xpath=//*[contains(text(),"개별 주문 및 배송 상세 내역")]/following::table[1]//tbody/tr'
      ).all();
      console.log(`  [${i+1}] 개별 배송 ${detailRows.length}건`);

      if (detailRows.length === 0) {
        // 표 못 찾으면 전체 페이지 텍스트 일부 덤프 (디버깅)
        const dump = (await page.locator('body').innerText()).slice(0, 1500);
        console.log(`     ⚠ 표 못찾음. 페이지 앞부분: ${dump.replace(/\n/g,' | ').slice(0,500)}`);
      }

      const couriers = ['천일','CJ','우체국','한진','롯데','로젠','대한통운','경동','쿠팡'];
      for (let j = 0; j < detailRows.length; j++) {
        try {
          const cells = await detailRows[j].locator('td').allTextContents();
          const cellText = cells.join(' | ');
          // 수취인: 첫 한글 2~4자 + 휴대폰 패턴이 같은 셀에 있을 확률 높음
          const telMatch = cellText.match(/010[-\s]?\d{3,4}[-\s]?\d{4}/);
          // 수취인 이름: 011~019, 010 패턴 앞 또는 한글 이름 패턴
          let name = '';
          const nameMatches = cellText.match(/([가-힣]{2,4})(?=[\s\(]*010)/g);
          if (nameMatches && nameMatches.length > 0) name = nameMatches[0];
          if (!name) {
            // fallback: 수취인 라벨 직후
            const lab = cellText.match(/수취인[:\s]+([가-힣]{2,4})/);
            if (lab) name = lab[1];
          }
          // 송장
          let courier = '', tracking = '';
          for (const c of couriers) {
            const m = cellText.match(new RegExp(c + '\\s*([0-9]{10,15})'));
            if (m) { courier = c; tracking = m[1]; break; }
          }
          if (!tracking) {
            const nums = cellText.match(/\b\d{10,15}\b/g) || [];
            const telDigits = telMatch ? telMatch[0].replace(/\D/g,'') : '';
            const trk = nums.find(n => n !== telDigits);
            if (trk) tracking = trk;
          }
          if (name && telMatch) {
            const tel = telMatch[0];
            const trkStr = courier && tracking ? `${courier} ${tracking}` : (tracking || '');
            results.push({ name, tel, tracking: trkStr, paid: isPaid });
            console.log(`     · ${name} / ${tel} → ${trkStr || '(송장 없음)'} · ${isPaid ? '결제완료' : '미결제'}`);
          } else {
            console.log(`     · [${j+1}] 추출실패 — 셀: ${cellText.slice(0,150)}`);
          }
        } catch(e){
          console.log(`     · [${j+1}] 행 파싱 오류: ${e.message}`);
        }
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

  let matched = 0, missed = 0, paidConfirmed = 0;
  try {
    await login(page);
    const scraped = await scrapeAllTracking(page);
    console.log(`📦 OMS에서 ${scraped.length}건 송장 정보 추출`);

    // 매칭 (이름 + 전화번호 우선, 전화 없으면 이름으로)
    for (const o of pending) {
      const name = normName(o.name);
      const tel = normTel(o.tel);
      if (!name) { missed++; continue; }

      let m = null;
      // 1단계: 이름+전화 둘 다 정확 매칭 (가장 안전)
      if (tel) {
        m = scraped.find(s => normTel(s.tel) === tel && normName(s.name) === name);
      }
      // 2단계: 전화 없거나 1단계 실패 → 이름 정확 매칭 (동명이인 없는 경우만)
      if (!m) {
        const sameName = scraped.filter(s => normName(s.name) === name);
        if (sameName.length === 1) m = sameName[0];
        else if (sameName.length > 1) {
          console.log(`  ⚠ 동명이인 ${sameName.length}명: "${o.name}" — 전화번호 없어서 매칭 보류`);
        }
      }
      // ⚠️ 이름 앞 2자 부분일치 폴백 제거 — "김민수" 주문에 "김민지" 송장이 박히는 오매칭 위험
      // (송장=배송·결제 증거라 오매칭=오배송 확정. 1·2단계 정확매칭만 신뢰, 나머지는 수동 처리가 안전)

      if (m) {
        // ① 송장 있으면 → tracking + 발송완료 (+ updateTracking이 oms_paid도 자동 처리)
        if (m.tracking) {
          await updateTracking(o.id, m.tracking, o);
          matched++;
          console.log(`✅ 송장 매칭: ${o.name} → ${m.tracking}`);
        }
        // ② 송장은 아직 없지만 결제완료 확인됨 → oms_paid만 자동 처리 (13시 전 결제 확인!)
        else if (m.paid && o.status === '발주완료' && !o.oms_paid) {
          if (isDry) {
            paidConfirmed++;
            console.log(`💳 결제 확인: ${o.name} → 결제완료 처리 (DRY)`);
          } else {
            const { error: omsErr } = await sb.from('orders').update({ oms_paid: true }).eq('id', o.id);
            if (omsErr) {
              missed++;
              console.warn(`⚠️ 결제완료 자동처리 실패 (${o.name}, id=${o.id}): ${omsErr.message} — DB에 oms_paid 컬럼이 있는지 확인 필요`);
            } else {
              paidConfirmed++;
              console.log(`💳 결제 확인: ${o.name} → 결제완료 처리`);
            }
          }
        } else {
          missed++;
          console.log(`⏭️  매칭됐으나 송장·결제 모두 미확인: ${o.name}`);
        }
      } else {
        missed++;
        console.log(`⏭️  매칭 실패 (아직 OMS에 없음?): ${o.name}`);
      }
    }
  } catch(e) {
    console.error('💥 봇 실패:', e.message);
    await page.screenshot({ path: 'screenshots/fatal.png', fullPage: true }).catch(()=>{});
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(`\n📊 결과: 송장 ${matched}건 / 결제확인 ${paidConfirmed}건 / 미매칭 ${missed}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
