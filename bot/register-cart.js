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

// GAS는 iframe 안에서 동작 — 메인 페이지와 iframe 양쪽 시도
async function getInteractiveFrame(page){
  // iframe이 있으면 그 frame 반환, 없으면 main page를 page 객체로 반환
  const iframeCount = await page.locator('iframe').count();
  if (iframeCount > 0) {
    return page.frameLocator('iframe').first();
  }
  return page;
}

async function login(page){
  console.log('🔐 카트사이트 접속...');
  await page.goto(CART_URL, { waitUntil:'networkidle', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path:'screenshots/01-cart-initial.png', fullPage:true });

  const frame = await getInteractiveFrame(page);
  // 로그인 폼 — 텍스트 input에 아이디 입력
  try {
    const idInput = frame.locator('input[type="text"]').first();
    await idInput.waitFor({ state:'visible', timeout: 8000 });
    await idInput.fill(CART_LOGIN_ID);
    console.log('  아이디 입력');
    // 로그인 버튼
    await frame.getByRole('button', { name: /로그인/ }).click();
    await page.waitForTimeout(2500);
  } catch(e) {
    // 이미 로그인되어 있을 수도
    console.log(`  로그인 폼 못 찾음 (이미 로그인됐을 수도): ${e.message}`);
  }
  await page.screenshot({ path:'screenshots/02-after-login.png', fullPage:true });
  console.log('✅ 로그인 완료');
}

async function registerOrder(page, order, idx){
  const tag = `${idx}-${(order.name||'?').replace(/[^가-힣a-z0-9]/gi,'')}`;
  console.log(`\n📝 [${idx}] ${order.name} / ${order.product} ${order.qty}개`);

  // 폼 페이지로 (이미 거기 있을 가능성 큼)
  // 필요시 "주문하기" 탭/버튼 클릭
  const frame = await getInteractiveFrame(page);
  try {
    await frame.getByRole('button', { name:'주문하기' }).first().click({ timeout: 3000 });
    await page.waitForTimeout(500);
  } catch {}
  await page.screenshot({ path:`screenshots/${tag}-1-form.png`, fullPage:true });

  // 제품 dropdown
  try {
    await frame.locator('select').first().selectOption({ label: order.product });
  } catch(e) {
    throw new Error(`제품 "${order.product}" 선택 실패: ${e.message}`);
  }

  // 수량
  const qty = Math.max(1, parseInt(order.qty)||1);
  try {
    await frame.locator('input[type="number"]').first().fill(String(qty));
  } catch {}

  // 옵션 dropdown (색상 등) — 모든 상품에 옵션 있는 건 아님
  if (order.color){
    try {
      // 두 번째 select (제품 다음)
      await frame.locator('select').nth(1).selectOption({ label: order.color });
    } catch(e) {
      console.log(`  옵션(${order.color}) 설정 실패 — 계속`);
    }
  }

  // 배송정보 textarea
  const shipInfo = `${order.name} / ${order.tel} / ${order.addr}`;
  try {
    await frame.getByPlaceholder(/수취인|배송지/).first().fill(shipInfo);
  } catch(e) {
    // fallback: 첫 textarea
    await frame.locator('textarea').first().fill(shipInfo);
  }

  await page.screenshot({ path:`screenshots/${tag}-2-filled.png`, fullPage:true });

  if (isDry){
    console.log('  [DRY RUN] "주문 등록하기" 클릭 생략');
    return;
  }
  await frame.getByRole('button', { name:'주문 등록하기' }).click();
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
