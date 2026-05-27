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
  // 직거래는 OMS 등록 X (손님과 직접 만나서 전달)
  const nonDirect = all.filter(o => o.type !== '직거래');
  // 지원 상품 매핑된 것 / 안 된 것 분리
  const supported   = nonDirect.filter(o => PRODUCT_URLS[`${o.product}|${o.color}`]);
  const unsupported = nonDirect.filter(o => !PRODUCT_URLS[`${o.product}|${o.color}`]);
  // 카트 상품 (다른 봇이 처리)
  const cartLike = new Set(['핸드카트','하체마사지기','족욕기','날개없는 선풍기','날개없는선풍기','철제선반']);
  const skippedDirect = all.length - nonDirect.length;
  if (skippedDirect > 0) console.log(`⏭️  직거래 ${skippedDirect}건 스킵 (OMS 등록 X)`);

  // 🔍 미매핑 주문 — 카트 상품이면 silent 스킵, 아니면 bot_note에 원인 기록 (사일런트 사고 방지)
  for (const o of unsupported) {
    const norm = (o.product || '').replace(/\s+/g, '');
    const isCart = [...cartLike].some(c => c.replace(/\s+/g,'') === norm);
    if (isCart) continue; // 카트 봇이 처리 — 정상 스킵
    const msg = `❌ ${new Date().toISOString().slice(0,16).replace('T',' ')}: 지원 안 하는 상품·색상 조합 — "${o.product}|${o.color}" (PRODUCT_URLS에 추가 필요)`;
    try { await sb.from('orders').update({ bot_note: msg }).eq('id', o.id); } catch {}
    console.log(`  ⚠️  미매핑 (bot_note 기록): ${o.product}|${o.color}`);
  }
  return supported;
}

async function markRegistered(id) {
  if (isDry) return;
  // 카트 봇과 일관성 맞춤 — 등록 후 바로 발주완료 (옛 발주대기 → 일괄완료 수동 단계 제거)
  const { error } = await sb.from('orders').update({ status: '발주완료' }).eq('id', id);
  if (error) throw error;
}

// ====== 주소 분리·검증 ======
const SIDO_KEYS = [
  '서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
  '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주',
  '충청북도', '충청남도', '전라북도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시',
  '경기도', '강원도', '강원특별자치도', '제주도'
];

function stripBusinessPrefix(addr) {
  if (!addr) return { addr: '', business: '' };
  const a = String(addr).replace(/\s+/g, ' ').trim();
  for (const key of SIDO_KEYS) {
    const idx = a.indexOf(key);
    if (idx > 0) {
      const prefix = a.slice(0, idx).trim();
      const rest = a.slice(idx).trim();
      if (prefix.length >= 1 && prefix.length <= 20 && !/^\d+$/.test(prefix)) {
        return { addr: rest, business: prefix };
      }
    }
  }
  return { addr: a, business: '' };
}

// 한국 주소 표준 패턴 — 동/로/길/가/리 + 번지까지가 기본주소, 그 뒤는 상세주소
// 예: "경기 안양시 만안구 안양동491-4 담소소담육개장" → base="...안양동491-4", extras="담소소담육개장"
function smartSplitAddress(addr) {
  const a = addr.replace(/\s+/g, ' ').trim();
  const m = a.match(/^(.+?(?:동|로|길|가|리)\s*\d+(?:-\d+)?)(?:번지)?\s+(.+)$/);
  if (m) return { base: m[1].trim(), extras: m[2].trim() };
  return null;
}

function splitAddress(addr) {
  if (!addr) return { base: '', detail: '', business: '' };
  const { addr: cleaned, business } = stripBusinessPrefix(addr);
  const a = cleaned.replace(/\s+/g, ' ').trim();
  // 1) 한국 주소 표준 패턴 (가장 정확)
  const smart = smartSplitAddress(a);
  if (smart) return { base: smart.base, detail: smart.extras, business };
  // 2) 옛 fallback 패턴
  let m = a.match(/^(.+?)\s+(\d+동\s*\d+호)$/);
  if (m) return { base: m[1].trim(), detail: m[2].replace(/\s+/g,'').trim(), business };
  m = a.match(/^(.+?)[\s,]+([\d\-]+호)$/);
  if (m) return { base: m[1].trim(), detail: m[2].trim(), business };
  m = a.match(/^(.+?)[\s,]+(\d+층)$/);
  if (m) return { base: m[1].trim(), detail: m[2].trim(), business };
  const i = a.lastIndexOf(',');
  if (i > 0) return { base: a.slice(0, i).trim(), detail: a.slice(i + 1).trim(), business };
  return { base: a, detail: '', business };
}

// 주소에서 (동/로/길) 이름 + 번지 추출 — 검증용
function extractRoadAndBunji(addr) {
  if (!addr) return null;
  const m = addr.match(/(\S+?(?:동|로|길|가|리))\s*(\d+(?:-\d+)?)/);
  return m ? { road: m[1].trim(), bunji: m[2].trim() } : null;
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
  const { base, detail, business } = splitAddress(order.addr);
  // 가게명/상호가 있었으면 상세주소 앞에 붙임 (택배기사가 식별하기 위해)
  const detailFinal = business ? (business + (detail ? ' ' + detail : '')) : detail;
  if (business) console.log(`  ⚠ 가게명 분리: "${business}" → 상세주소로 이동`);
  console.log(`  주소 분리: [기본] ${base}  [상세] ${detailFinal}`);

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
      try { await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
      try { await popup.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      await popup.waitForTimeout(2000);
      await popup.screenshot({ path: `screenshots/${tag}-2-popup.png`, fullPage: true }).catch(()=>{});

      // 진단: popup 내부 frame 구조
      const frames = popup.frames();
      console.log(`  popup URL: ${popup.url()}, frames: ${frames.length}`);
      let searchFrame = null;
      let searchLocator = null;
      // 모든 프레임에서 input 찾기
      for (const f of frames) {
        try {
          const cnt = await f.locator('input').count();
          console.log(`    frame ${f.url().slice(0,80)}: ${cnt} inputs`);
          if (cnt > 0 && !searchFrame) {
            searchFrame = f;
            searchLocator = f.locator('input').first();
          }
        } catch(e) { /* cross-origin frame might error */ }
      }
      if (!searchLocator) throw new Error('카카오 우편번호 popup에 input 없음');

      await searchLocator.waitFor({ state: 'visible', timeout: 8000 });
      await searchLocator.fill(base);
      await searchLocator.press('Enter');
      await popup.waitForTimeout(2500);
      await popup.screenshot({ path: `screenshots/${tag}-2-popup-results.png`, fullPage: true }).catch(()=>{});

      // 검색 결과 첫 줄 (같은 frame에서)
      await searchFrame.locator('li, dl, .result_item, [class*="result"]').first().click({ timeout: 8000 });
      await page.waitForTimeout(1500);
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

    // 🛡️ 안전장치: 카카오가 채운 기본주소를 읽어서 입력값과 비교
    // 카카오가 비슷한 다른 주소(학연로 vs 학현로)로 자동매칭한 경우 캐치
    const filledBase = await page.getByPlaceholder(/기본 주소/).inputValue().catch(() => '');
    if (filledBase) {
      const inRB  = extractRoadAndBunji(base);
      const outRB = extractRoadAndBunji(filledBase);
      console.log(`  주소 검증: 입력 "${inRB?.road} ${inRB?.bunji}" vs 카카오 "${outRB?.road} ${outRB?.bunji}"`);
      if (inRB && outRB && (inRB.road !== outRB.road || inRB.bunji !== outRB.bunji)) {
        throw new Error(
          `🚨 주소 불일치 — 카카오가 다른 곳으로 매칭함\n` +
          `  입력: "${inRB.road} ${inRB.bunji}"  →  카카오: "${outRB.road} ${outRB.bunji}"\n` +
          `  앱에서 주소를 수정(검색 버튼으로 정확한 주소 선택) 후 다시 시도하세요.`
        );
      }
    }
  }

  // 상세 주소 (가게명 + 동/호 포함)
  await page.getByPlaceholder(/상세 주소/).fill(detailFinal);

  await page.screenshot({ path: `screenshots/${tag}-3-filled.png` });

  // 판매 관리 등록
  if (isDry) {
    console.log('  [DRY RUN] "판매 관리 등록" 클릭 생략');
    return;
  }

  // 더 좁은 셀렉터 — "회원등록" 같은 헷갈리는 버튼 매칭 방지
  const submitBtn = page.getByRole('button', { name: /^판매\s*관리\s*등록$/ }).first();
  if (await submitBtn.count() === 0) {
    // fallback — "등록" 단독 버튼 (제출용)
    const fallback = page.locator('button:has-text("등록"):not(:has-text("회원")):not(:has-text("가입"))').last();
    await fallback.scrollIntoViewIfNeeded();
    await fallback.click();
  } else {
    await submitBtn.scrollIntoViewIfNeeded();
    await submitBtn.click();
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `screenshots/${tag}-4-after-submit.png`, fullPage: true });

  // 🛡️ 명시적 에러 신호만 잡음 — 폼 잔존 / 일반 안내 텍스트는 정상으로 간주
  // OMS는 등록 후에도 같은 페이지에 머물 수 있고, "필수 입력" 같은 일반 안내가 항상 떠있을 수 있음
  // 진짜 에러일 때만 명시적 패턴으로 잡기 (오등록보다 누락이 더 안전)
  const bodyText = await page.locator('body').innerText().catch(() => '');
  // 명시적 실패 패턴만 — "등록 실패", "등록 오류", "에러가 발생" 등
  const errorMatch = /등록 실패|등록 오류|등록되지 않|에러가 발생|오류가 발생|등록할 수 없/i.test(bodyText);

  if (errorMatch) {
    const errSnippet = bodyText.match(/.{0,40}(등록 실패|등록 오류|등록되지 않|에러가 발생|오류가 발생|등록할 수 없).{0,40}/)?.[0] || '등록 실패';
    throw new Error(`OMS 등록 거부: ${errSnippet.replace(/\s+/g,' ').trim()}`);
  }
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
        // 성공시 이전 에러 note 클리어 (Supabase는 .catch 없음 → try/catch로 래핑)
        try { await sb.from('orders').update({ bot_note: null }).eq('id', orders[i].id); } catch {}
        ok++;
      } catch (e) {
        console.error(`❌ 실패: ${e.message}`);
        try { await page.screenshot({ path: `screenshots/fail-${i+1}.png`, fullPage: true }); } catch {}
        // 앱에서 보이도록 주문에 에러 메시지 기록 (bot_note 컬럼)
        const msg = `❌ ${new Date().toISOString().slice(0,16).replace('T',' ')}: ${e.message.slice(0,300)}`;
        try { await sb.from('orders').update({ bot_note: msg }).eq('id', orders[i].id); } catch {}
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

  // 푸시 알림 — 성공이든 실패든 발주대기/실패 상황 알림
  if (ok > 0 || fail > 0) {
    try { await notifyAdmins(ok, fail); } catch (e) { console.warn('푸시 알림 실패(무시):', e.message); }
  }

  if (fail > 0 && ok === 0) process.exit(1);
}

// 등록 직후 관리자 푸시 — 발주완료 → 결제 필요 알리기
async function notifyAdmins(okCount, failCount) {
  const isManual = process.env.MANUAL_RUN === 'true';
  const hasFailure = failCount > 0;
  // ⏰ KST 시간 가드 — 자동 cron + 성공만 (수동 / 실패는 항상 푸시)
  // 이유:
  //   - 자동 cron + 성공 = 점심 시간(12~14)에만 알림 의미 있음 (지연 발화 새벽·한밤 차단)
  //   - 수동 실행 = 관리자가 결과 보고 싶어서 누른 거 → 우회
  //   - 실패 = 언제 발생하든 즉시 알아야 함 (08:02 봇 실패도 가시화) → 우회
  if (!isManual && !hasFailure) {
    const kstHour = parseInt(new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit'
    }));
    if (kstHour < 12 || kstHour > 14) {
      console.log(`  ⏭️  현재 KST ${kstHour}시 — 푸시 시간대(12~14) 아님. 등록은 OK, 푸시만 skip.`);
      return;
    }
  } else if (isManual) {
    console.log('  📣 수동 실행 — 시간 가드 우회, 푸시 전송');
  } else if (hasFailure) {
    console.log(`  ⚠️ 실패 ${failCount}건 — 시간 가드 우회, 즉시 알림 전송`);
  }

  const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT     = process.env.VAPID_SUBJECT;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.log('  ℹ️  VAPID 환경변수 없음 — 푸시 스킵');
    return;
  }
  const { default: webpush } = await import('web-push');
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const { data: admins } = await sb.from('profiles').select('id').eq('role','admin');
  const adminIds = (admins||[]).map(a => a.id);
  if (adminIds.length === 0) return;
  const { data: subs } = await sb.from('push_subscriptions').select('*').in('user_id', adminIds);
  if (!subs || subs.length === 0) return;

  // 잠금화면 가독성 — 짧고 명확하게
  const title = (okCount === 0 && failCount > 0)
    ? `⚠️ 발주 실패 ${failCount}건`
    : `✅ ${okCount}건 발주 완료`;
  const body  = (okCount === 0 && failCount > 0)
    ? `앱에서 빨간 메시지 확인 후 수정 필요`
    : `💳 12:55 전 결제·송금 필요`
      + (failCount > 0 ? `\n⚠️ ${failCount}건 실패 — 앱 확인` : '');

  const payload = JSON.stringify({
    title,
    body,
    tag: 'post-register-' + new Date().toISOString().slice(0,13),
    url: '/'
  });

  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      }
    }
  }
  console.log(`  📲 푸시 전송: ${sent}/${subs.length}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
