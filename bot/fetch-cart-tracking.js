// 카트사이트(GAS) 송장 자동수집 봇
// 페이지 흐름: 로그인 → [배송조회(수정)] 탭 → [내 주문 조회하기] → 카드들에서 송장 추출
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, DRY_RUN } = process.env;
const isDry = DRY_RUN === 'true' || DRY_RUN === true;

const CART_URL = 'https://script.google.com/macros/s/AKfycbyK1MU-BWQeiNwv1Sx5BP4pesUytBmYmCTDDXdna24hRB6YY5sB6M1l_2xfQmDMKdmw7w/exec';
const CART_LOGIN_ID = 'comltd';
const CART_PRODUCTS = ['핸드카트','하체마사지기','족욕기','날개없는 선풍기','철제선반'];
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
    .or('tracking.is.null,tracking.eq.');
  if(error) throw error;
  return (data||[]).filter(o => isCartProduct(o.product));
}

async function updateTracking(id, value){
  if(isDry) return;
  const { error } = await sb.from('orders').update({
    tracking: value,
    status: '발송완료',
    shipped_at: new Date().toISOString()
  }).eq('id', id);
  if(error) throw error;
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
  await page.waitForTimeout(3500);
  await page.screenshot({ path:'screenshots/03-tracking-list.png', fullPage:true });
}

// 카트사이트 카드 구조 파싱
// 각 카드: [출고완료/배송중] 0514·핸드카트·중형·1개 / 이름 전화 / 주소 / 택배사 · 송장번호
async function extractTrackings(frame){
  console.log('🔍 송장 정보 추출 중...');
  const bodyText = await frame.locator('body').innerText();
  // 택배사 목록 (긴 이름 먼저)
  const couriers = ['CJ대한통운','대한통운','한진택배','한진','롯데택배','롯데','로젠','우체국','천일','경동','쿠팡','CJ'];
  const results = [];
  // 카드 단위로 분리 (출고완료/배송중/주문확인 등으로 시작하는 블록)
  // 정규식으로 [이름 + 전화 + ... + 택배사 + 송장번호] 패턴 찾기
  // 더 강력한 방법: 각 줄에서 정보 누적
  const lines = bodyText.split('\n').map(l=>l.trim()).filter(Boolean);
  let curName = null, curTel = null;
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    // 전화번호 패턴 (01N + 7~8자리)
    const telMatch = line.match(/01[0-9]\s*[-]?\s*\d{3,4}\s*[-]?\s*\d{4}/);
    if (telMatch){
      curTel = telMatch[0];
      // 같은 줄에 이름 (전화 앞)
      const before = line.slice(0, telMatch.index).trim();
      const nameMatch = before.match(/([가-힣]{2,4})\s*$/);
      if (nameMatch){
        curName = nameMatch[1];
      } else {
        // 다른 줄 (직전 줄)에 이름 있을 수도
        for (let j = i-1; j >= Math.max(0, i-3); j--){
          const nm = lines[j].match(/^([가-힣]{2,4})$/);
          if (nm){ curName = nm[1]; break; }
        }
      }
    }
    // 송장 패턴 — 택배사 + 숫자
    for (const c of couriers){
      const re = new RegExp(c + '\\s*[·\\-]?\\s*(\\d{10,15})');
      const m = line.match(re);
      if (m){
        if (curName && curTel){
          results.push({
            name: curName,
            tel: curTel,
            tracking: c + ' ' + m[1]
          });
          curName = null; curTel = null;
        }
        break;
      }
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
        await updateTracking(o.id, m.tracking);
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
