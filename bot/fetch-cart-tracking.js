// 카트사이트(GAS) 송장 자동수집 봇
// 페이지 흐름: 로그인 → [배송조회(수정)] 탭 → [내 주문 조회하기] → 카드들에서 송장 추출
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, DRY_RUN } = process.env;
const isDry = DRY_RUN === 'true' || DRY_RUN === true;

const CART_URL = 'https://script.google.com/macros/s/AKfycbyK1MU-BWQeiNwv1Sx5BP4pesUytBmYmCTDDXdna24hRB6YY5sB6M1l_2xfQmDMKdmw7w/exec';
const CART_LOGIN_ID = 'comltd';
// ⚠️ 앱(index.html) + register-cart.js와 반드시 동일하게 유지할 것
// 철제선반은 선반랙(OMS) 취급 — 카트사이트 대상 아님 (cc39e7b에서 카트 목록서 제거됨)
const CART_PRODUCTS = ['핸드카트','하체마사지기','족욕기','날개없는 선풍기'];
function isCartProduct(p){
  if(!p) return false;
  const norm = p.replace(/\s+/g,'');
  return CART_PRODUCTS.some(cp => cp.replace(/\s+/g,'') === norm);
}

for (const [k,v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })){
  if (!v){ console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}
fs.mkdirSync('screenshots', { recursive: true });

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth:{ autoRefreshToken:false, persistSession:false }
});

const normTel = t => (t||'').replace(/\D/g, '');
const normName = n => (n||'').replace(/\s+/g,'').trim();

async function fetchPending(){
  // 카트 상품 중 송장 없는 것 (발주완료/발송완료 둘 다)
  const { data, error } = await sb.from('orders').select('*')
    .in('status', ['발주완료','발송완료'])
    .or('tracking.is.null,tracking.eq.""');
  if(error) throw error;
  return (data||[]).filter(o => isCartProduct(o.product));
}

async function updateTracking(id, value, currentOrder){
  if(isDry) return;
  // shipped_at 이미 있으면 보존 (72H 카운터 리셋 방지)
  const updates = {
    tracking: value,
    status: '발송완료',
    bot_note: null
  };
  if (!currentOrder?.shipped_at) {
    updates.shipped_at = new Date().toISOString();
  }
  const { error } = await sb.from('orders').update(updates).eq('id', id);
  if(error) throw error;
  // 💳 송장 = 결제+출고 증거 → OMS 결제완료 자동 처리
  const { error: omsErr } = await sb.from('orders').update({ oms_paid: true }).eq('id', id);
  if (omsErr) console.warn(`⚠️ oms_paid 자동처리 실패 (id=${id}): ${omsErr.message} — DB에 oms_paid 컬럼이 있는지 확인 필요`);
}

// GAS 다중 iframe — input 들어있는 frame 반환
async function getInteractiveFrame(page){
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(2500);
  const allFrames = page.frames();
  for (const f of allFrames){
    try {
      const inputCnt = await f.locator('input').count();
      if (inputCnt > 0) return f;
    } catch {}
  }
  return page;
}

async function login(page){
  console.log('🔐 카트사이트 접속...');
  await page.goto(CART_URL, { waitUntil:'networkidle', timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path:'screenshots/01-initial.png', fullPage:true });
  let frame = await getInteractiveFrame(page);
  // 아이디 입력
  for (const sel of ['input[placeholder*="아이디"]', 'input[type="text"]', 'input']){
    try {
      const inp = frame.locator(sel).first();
      await inp.waitFor({ state:'visible', timeout: 4000 });
      await inp.fill(CART_LOGIN_ID);
      console.log(`  아이디 입력 (${sel})`);
      break;
    } catch {}
  }
  // 로그인 버튼
  for (const fn of [
    () => frame.getByRole('button', { name:/로그인하기/ }),
    () => frame.getByRole('button', { name:/로그인/ }),
    () => frame.locator('button:has-text("로그인")')
  ]){
    try { await fn().click({ timeout: 3000 }); break; } catch {}
  }
  await page.waitForTimeout(4000);
  await page.screenshot({ path:'screenshots/02-after-login.png', fullPage:true });
  console.log('✅ 로그인 완료');
  return await getInteractiveFrame(page);
}

async function navigateToTracking(page, frame){
  console.log('📋 배송조회 탭으로 이동...');
  // [배송조회(수정)] 탭 클릭
  for (const fn of [
    () => frame.getByRole('button', { name:/배송조회/ }),
    () => frame.locator('button:has-text("배송조회")'),
    () => frame.locator('a:has-text("배송조회")')
  ]){
    try { await fn().first().click({ timeout: 3000 }); console.log('  배송조회 탭 클릭'); break; } catch {}
  }
  await page.waitForTimeout(1500);
  // [최근 주문] (선택) — 더 최근 데이터 보려면
  for (const fn of [
    () => frame.locator('button:has-text("최근 주문")'),
    () => frame.locator('button:has-text("최근주문")')
  ]){
    try { await fn().first().click({ timeout: 2000 }); console.log('  최근 주문 탭 클릭'); break; } catch {}
  }
  await page.waitForTimeout(1500);
  // [내 주문 조회하기] 버튼
  for (const fn of [
    () => frame.locator('button:has-text("내 주문 조회하기")'),
    () => frame.locator('button:has-text("조회하기")'),
    () => frame.locator('button:has-text("내 주문")')
  ]){
    try { await fn().first().click({ timeout: 3000 }); console.log('  조회 버튼 클릭'); break; } catch {}
  }
  // 카드가 로딩될 때까지 대기 — "조회 중이에요" 사라지고 실제 데이터 나올 때까지
  console.log('  카드 로딩 대기 중...');
  let loaded = false;
  for (let i = 0; i < 30; i++){  // 최대 30초
    await page.waitForTimeout(1000);
    try {
      const bodyText = await frame.locator('body').innerText();
      // 전화번호 패턴이 나타나면 로딩 완료
      if (/01[0-9][\s-]?\d{3,4}[\s-]?\d{4}/.test(bodyText)){
        console.log(`  카드 로딩 완료 (${i+1}초 후)`);
        loaded = true;
        break;
      }
      // 또는 "조회 중이에요" 안 나오면 (조회 결과 0건 가능)
      if (!bodyText.includes('조회 중')){
        console.log(`  조회 완료 (${i+1}초, 결과 0건 가능)`);
        loaded = true;
        break;
      }
    } catch {}
  }
  if (!loaded) console.log('  ⚠️ 30초 대기 후에도 로딩 미완료 — 그래도 추출 시도');
  await page.waitForTimeout(1500);  // 마지막 안정화
  await page.screenshot({ path:'screenshots/03-tracking-list.png', fullPage:true });
}

// 카트사이트 카드 구조 파싱 — 전화번호 기준으로 카드 단위 추출
async function extractTrackings(frame){
  console.log('🔍 송장 정보 추출 중...');
  const bodyText = await frame.locator('body').innerText();
  // 디버그: 페이지 텍스트 일부 출력 (셀렉터 보강 단서)
  console.log('--- 페이지 텍스트 (앞 1500자) ---');
  console.log(bodyText.slice(0, 1500));
  console.log('--- /끝 ---');

  const couriers = ['CJ대한통운','대한통운','한진택배','한진','롯데택배','롯데','로젠','우체국','천일','경동','쿠팡','CJ','GS'];
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const phoneRe = /01[0-9]\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}/g;
  const addressTerms = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주','충청','전라','경상','특별시','광역시','시','구','동','로','길','번지','읍','면','리','아파트','빌라','오피스텔','빌딩'];

  const results = [];
  const matches = [...bodyText.matchAll(phoneRe)];
  console.log(`  전화번호 ${matches.length}개 발견`);

  for (let i = 0; i < matches.length; i++){
    const m = matches[i];
    const startIdx = m.index;
    const endIdx = i+1 < matches.length ? matches[i+1].index : bodyText.length;
    const tel = m[0];

    // 이름 — 전화번호 직전 100자 안의 마지막 한글 (주소 키워드 제외)
    const beforePhone = bodyText.slice(Math.max(0, startIdx - 120), startIdx);
    const koreans = beforePhone.match(/[가-힣]{2,4}/g) || [];
    const validNames = koreans.filter(k =>
      !addressTerms.some(a => k.includes(a) || a.includes(k))
    );
    const name = validNames.length > 0 ? validNames[validNames.length - 1] : null;

    // 송장 — 전화번호 직후 ~500자 안의 택배사 + 숫자 (다음 전화번호 전까지)
    const afterPhone = bodyText.slice(startIdx, Math.min(endIdx, startIdx + 500));
    let tracking = null;
    for (const c of couriers){
      const re = new RegExp(escRe(c) + '\\s*[·\\-]?\\s*(\\d{10,15})');
      const tm = afterPhone.match(re);
      if (tm){ tracking = c + ' ' + tm[1]; break; }
    }
    // 택배사 없이 숫자만 있는 경우 fallback (전화번호 아닌 10~15자리)
    if (!tracking){
      const telDigits = tel.replace(/\D/g,'');
      const nums = afterPhone.match(/\b\d{10,15}\b/g) || [];
      const trk = nums.find(n => n !== telDigits && n.length >= 10);
      if (trk) tracking = trk;
    }

    if (name && tracking){
      results.push({ name, tel, tracking });
    } else {
      console.log(`  [${i+1}] 미완성 — 이름:${name||'?'} 전화:${tel} 송장:${tracking||'?'}`);
    }
  }
  results.forEach((r,i) => {
    console.log(`  [${i+1}] ${r.name} / ${r.tel} → ${r.tracking}`);
  });
  return results;
}

async function main(){
  console.log(`🤖 카트 송장수집 봇 시작 (DRY_RUN=${isDry})`);
  const pending = await fetchPending();
  console.log(`📋 송장 수집 대상 (카트 상품): ${pending.length}건`);
  if (pending.length === 0){ console.log('대상 없음. 종료.'); return; }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:{ width:1366, height:800 },
    locale:'ko-KR',
    timezoneId:'Asia/Seoul'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let matched = 0, missed = 0;
  try {
    const frame = await login(page);
    await navigateToTracking(page, frame);
    const scraped = await extractTrackings(frame);
    console.log(`📦 카트사이트에서 ${scraped.length}건 송장 추출`);

    for (const o of pending){
      const name = normName(o.name);
      const tel = normTel(o.tel);
      if (!name){ missed++; continue; }

      // 매칭: 이름+전화 우선, 전화 없으면 이름만
      let m = null;
      if (tel){
        m = scraped.find(s => normTel(s.tel) === tel && normName(s.name) === name);
      }
      if (!m){
        const sameName = scraped.filter(s => normName(s.name) === name);
        if (sameName.length === 1) m = sameName[0];
        else if (sameName.length > 1){
          console.log(`  ⚠ 동명이인 ${sameName.length}명: "${o.name}" — 전화번호 없어 보류`);
        }
      }

      if (m && m.tracking){
        await updateTracking(o.id, m.tracking, o);
        matched++;
        console.log(`✅ ${o.name} → ${m.tracking}`);
      } else {
        missed++;
        console.log(`⏭️  매칭 실패: ${o.name}`);
      }
    }
  } catch(e){
    console.error('💥 봇 전체 실패:', e.message);
    try { await page.screenshot({ path:'screenshots/fatal.png', fullPage:true }); } catch {}
    await browser.close();
    process.exit(1);
  }

  await browser.close();
  console.log(`\n📊 결과: 업데이트 ${matched}건 / 미매칭 ${missed}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
