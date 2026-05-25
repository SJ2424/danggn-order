// 카트사이트(GAS) 자동 주문 봇
// 로그인: 아이디 "comltd" 입력만 하면 됨 (비밀번호 없음)
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

for (const [k,v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v){ console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}
fs.mkdirSync('screenshots', { recursive: true });

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth:{ autoRefreshToken:false, persistSession:false }
});

async function fetchPending(){
  const { data, error } = await sb.from('orders').select('*').eq('status','접수');
  if(error) throw error;
  const list = (data||[]).filter(o => isCartProduct(o.product));
  return list;
}

async function markRegistered(id){
  if(isDry) return;
  await sb.from('orders').update({ status:'발주완료' }).eq('id', id);
}

// GAS 웹앱은 다중 iframe (안내문 iframe + 실제 앱 sandbox iframe)
// input이 들어있는 frame을 찾아서 반환
async function getInteractiveFrame(page){
  // GAS 충분히 로드되게 대기
  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(2500);
  // 모든 frame 순회 (top + nested)
  const allFrames = page.frames();
  console.log(`  전체 frame ${allFrames.length}개 발견`);
  for (const f of allFrames){
    try {
      const inputCnt = await f.locator('input').count();
      const url = f.url();
      console.log(`    · ${url.slice(0,80)} → input ${inputCnt}개`);
      if (inputCnt > 0) return f;
    } catch {}
  }
  // 다 실패하면 main page
  return page;
}

async function login(page){
  console.log('🔐 카트사이트 접속...');
  await page.goto(CART_URL, { waitUntil:'networkidle', timeout: 30000 });
  await page.waitForTimeout(3500);
  await page.screenshot({ path:'screenshots/01-cart-initial.png', fullPage:true });

  let frame = await getInteractiveFrame(page);
  // 1) 아이디 input — placeholder/type 여러 후보 시도
  const inputSelectors = [
    'input[placeholder*="아이디"]',
    'input[type="text"]',
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"])',
    'input'
  ];
  let filled = false;
  for (const sel of inputSelectors){
    try {
      const inp = frame.locator(sel).first();
      await inp.waitFor({ state:'visible', timeout: 4000 });
      await inp.fill(CART_LOGIN_ID);
      console.log(`  아이디 입력 (${sel})`);
      filled = true;
      break;
    } catch {}
  }
  if (!filled){
    await page.screenshot({ path:'screenshots/02-login-input-fail.png', fullPage:true });
    throw new Error('로그인 input 못 찾음 — GAS 페이지 구조 변경 가능성');
  }

  // 2) 로그인 버튼 — 후보 여러 개
  let clicked = false;
  const btnCandidates = [
    () => frame.getByRole('button', { name: /로그인하기/ }),
    () => frame.getByRole('button', { name: /로그인/ }),
    () => frame.locator('button:has-text("로그인하기")'),
    () => frame.locator('button:has-text("로그인")'),
    () => frame.locator('button').first()
  ];
  for (const fn of btnCandidates){
    try {
      await fn().click({ timeout: 3000 });
      clicked = true;
      console.log('  로그인 버튼 클릭');
      break;
    } catch {}
  }
  if (!clicked){
    await page.screenshot({ path:'screenshots/02-login-btn-fail.png', fullPage:true });
    throw new Error('로그인 버튼 못 찾음');
  }

  // 로그인 후 페이지 전환 대기
  await page.waitForTimeout(4000);
  await page.screenshot({ path:'screenshots/02-after-login.png', fullPage:true });
  console.log('✅ 로그인 완료');
}

async function registerOrder(page, order, idx){
  const tag = `${idx}-${(order.name||'?').replace(/[^가-힣a-z0-9]/gi,'')}`;
  console.log(`\n📝 [${idx}] ${order.name} / ${order.product} ${order.qty}개`);

  // 로그인 후 폼 frame 다시 잡기 (페이지 전환됐을 수도)
  const frame = await getInteractiveFrame(page);

  // "주문하기" 탭/버튼 (있으면 클릭)
  for (const fn of [
    () => frame.getByRole('button', { name:'주문하기' }),
    () => frame.locator('button:has-text("주문하기")'),
    () => frame.locator('a:has-text("주문하기")')
  ]){
    try { await fn().first().click({ timeout: 2500 }); await page.waitForTimeout(800); break; } catch {}
  }
  await page.screenshot({ path:`screenshots/${tag}-1-form.png`, fullPage:true });

  // 제품 — select 또는 다른 형식
  const selectCnt = await frame.locator('select').count().catch(()=>0);
  console.log(`  select ${selectCnt}개 발견`);
  if (selectCnt > 0){
    try {
      await frame.locator('select').first().selectOption({ label: order.product });
      console.log(`  제품 선택: ${order.product}`);
    } catch(e){
      // label 매칭 실패 → 부분 매칭 시도
      try {
        const options = await frame.locator('select').first().locator('option').allTextContents();
        const match = options.find(o => o.includes(order.product));
        if (match){
          await frame.locator('select').first().selectOption({ label: match });
          console.log(`  제품 선택 (부분일치): ${match}`);
        } else {
          throw new Error(`옵션에 "${order.product}" 없음. 옵션들: ${options.join(', ')}`);
        }
      } catch(e2){
        throw new Error(`제품 "${order.product}" 선택 실패: ${e2.message}`);
      }
    }
  } else {
    throw new Error('select 요소를 찾을 수 없음 — 폼 구조 확인 필요');
  }
  await page.waitForTimeout(800);

  // 수량
  const qty = Math.max(1, parseInt(order.qty)||1);
  try {
    const qtyInput = frame.locator('input[type="number"]').first();
    if (await qtyInput.count() > 0){
      await qtyInput.fill(String(qty));
      console.log(`  수량 ${qty} 입력`);
    }
  } catch {}

  // 옵션 (색상) — 두 번째 select
  if (order.color && selectCnt > 1){
    try {
      await frame.locator('select').nth(1).selectOption({ label: order.color });
      console.log(`  색상 ${order.color} 선택`);
    } catch(e){
      console.log(`  색상(${order.color}) 설정 실패 — 계속`);
    }
  }

  // 배송정보
  const shipInfo = `${order.name} / ${order.tel} / ${order.addr}`;
  let shipFilled = false;
  for (const fn of [
    () => frame.getByPlaceholder(/수취인|배송지|받는|주소/),
    () => frame.locator('textarea'),
    () => frame.locator('input[type="text"]').last()
  ]){
    try {
      await fn().first().fill(shipInfo, { timeout: 2500 });
      shipFilled = true;
      console.log(`  배송정보 입력`);
      break;
    } catch {}
  }
  if (!shipFilled) console.log(`  ⚠️ 배송정보 입력 실패 — 폼 확인 필요`);

  await page.screenshot({ path:`screenshots/${tag}-2-filled.png`, fullPage:true });

  if (isDry){
    console.log('  [DRY RUN] "주문 등록하기" 클릭 생략');
    return;
  }
  for (const fn of [
    () => frame.getByRole('button', { name:/주문 등록|등록하기|주문하기/ }),
    () => frame.locator('button:has-text("주문 등록하기")'),
    () => frame.locator('button:has-text("등록")').last()
  ]){
    try { await fn().first().click({ timeout: 3000 }); break; } catch {}
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path:`screenshots/${tag}-3-submitted.png`, fullPage:true });
  console.log('✅ 등록 완료');
}

async function main(){
  console.log(`🤖 카트사이트 봇 시작 (DRY_RUN=${isDry})`);
  const orders = await fetchPending();
  console.log(`📋 등록 대상 (카트 상품): ${orders.length}건`);
  if (orders.length === 0){ console.log('대상 없음. 종료.'); return; }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport:{ width:1366, height:800 },
    locale:'ko-KR',
    timezoneId:'Asia/Seoul'
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  let ok=0, fail=0;
  try {
    await login(page);
    for (let i=0; i<orders.length; i++){
      try {
        await registerOrder(page, orders[i], i+1);
        await markRegistered(orders[i].id);
        ok++;
      } catch(e){
        console.error(`❌ 실패: ${e.message}`);
        await page.screenshot({ path:`screenshots/fail-${i+1}.png`, fullPage:true }).catch(()=>{});
        fail++;
      }
    }
  } catch(e){
    console.error('💥 전체 실패:', e.message);
    await page.screenshot({ path:'screenshots/fatal.png', fullPage:true }).catch(()=>{});
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  console.log(`\n📊 결과: 성공 ${ok}건 / 실패 ${fail}건`);
  if (fail>0 && ok===0) process.exit(1);
}

main().catch(e=>{ console.error(e); process.exit(1); });
