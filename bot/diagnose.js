// 🩺 라이브 DB 자가진단 — 결과를 diagnostics/latest.md 로 저장 (커밋되어 사람/AI가 읽음)
// ⚠️ 개인정보(이름·전화·주소) 미포함 원칙 — 집계 숫자·플래그만 출력 (저장소 공개 대비)
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('❌ 환경변수 누락 (SUPABASE_URL / SUPABASE_SERVICE_KEY)'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const lines = [];
const log = s => { lines.push(s); console.log(s); };

// 컬럼 존재 확인 — select(col)가 에러나면 없음으로 판정
async function colExists(table, col) {
  const { error } = await sb.from(table).select(col).limit(1);
  if (!error) return true;
  const m = (error.message || '') + ' ' + (error.code || '') + ' ' + (error.details || '');
  if (/does not exist|could not find|schema cache|42703|PGRST204/i.test(m)) return false;
  return '확인불가(' + (error.message || error.code) + ')';
}

// 페이지네이션 로드 (대용량 대비)
async function loadAll(table, cols) {
  let all = [], from = 0; const PAGE = 1000;
  while (true) {
    const { data, error } = await sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  const nowKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  log(`# 🩺 라이브 DB 자가진단 리포트`);
  log(`> 생성: **${nowKST} KST** · 개인정보(이름·전화·주소) 미포함 — 집계/플래그만\n`);

  // 1) 컬럼 존재 (오늘 수정한 것들이 실DB에 반영됐는지)
  log(`## 1. 컬럼 존재 확인`);
  const checks = [
    ['orders', 'oms_paid'], ['orders', 'settled'], ['orders', 'shipped_at'],
    ['orders', 'bot_note'], ['orders', 'memo'], ['orders', 'cost_price'], ['orders', 'rep_price'],
    ['orders', 'bot_claimed_at'],
    ['products', 'default_cost_pickup'], ['profiles', 'approved_at'],
  ];
  const colState = {};
  for (const [t, c] of checks) {
    const r = await colExists(t, c);
    colState[`${t}.${c}`] = r;
    log(`- \`${t}.${c}\`: ${r === true ? '✅ 있음' : r === false ? '❌ 없음' : '⚠️ ' + r}`);
  }
  const hasOmsPaid = colState['orders.oms_paid'] === true;

  // 2) 주문 현황 (PII 제외 컬럼만 select)
  log(`\n## 2. 주문 현황`);
  const sel = ['status', 'paid', 'tracking', 'type', 'cost_price', 'rep_price', 'bot_note', 'created_at', 'shipped_at']
    .concat(hasOmsPaid ? ['oms_paid'] : []).join(',');
  const orders = await loadAll('orders', sel);
  const n = orders.length;
  const cnt = (pred) => orders.filter(pred).length;
  const groupBy = (f) => orders.reduce((a, o) => { const k = f(o); a[k] = (a[k] || 0) + 1; return a; }, {});
  const status = groupBy(o => o.status || '(없음)');
  log(`- 총 주문: **${n}건**`);
  log(`- 상태별: ${Object.entries(status).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
  log(`- 입금완료(paid): ${cnt(o => o.paid)} · 송장있음: ${cnt(o => o.tracking)} · 직거래: ${cnt(o => o.type === '직거래')} · 택배: ${cnt(o => o.type === '택배')}`);
  log(`- OMS결제(oms_paid): ${hasOmsPaid ? cnt(o => o.oms_paid) : '(컬럼없음 → 결제체크 작동안함)'}`);

  // 3) 이상 징후 (0이면 정상)
  log(`\n## 3. 이상 징후 (0이면 정상)`);
  const dayMs = 24 * 3600 * 1000, now = Date.now();
  const flag = (label, c) => log(`- ${label}: **${c}건** ${c ? '⚠️' : '✅'}`);
  flag('원가(cost_price) 미설정 — 트리거 누락 의심', cnt(o => o.cost_price == null || o.cost_price === 0));
  flag('납품가(rep_price) 미설정 — 트리거 누락 의심', cnt(o => o.rep_price == null || o.rep_price === 0));
  flag('발주완료인데 송장없이 3일+ (등록 누락/거짓성공 의심)', cnt(o => o.status === '발주완료' && o.type !== '직거래' && !o.tracking && o.created_at && (now - new Date(o.created_at).getTime()) > 3 * dayMs));
  flag('봇 실패메시지(bot_note) 남은 주문', cnt(o => o.bot_note));
  if (hasOmsPaid) flag('직거래인데 OMS결제 표시(모순)', cnt(o => o.type === '직거래' && o.oms_paid));
  flag('발송완료·미입금 7일+ (수금 추적 필요)', cnt(o => !o.paid && o.status === '발송완료' && o.shipped_at && (now - new Date(o.shipped_at).getTime()) > 7 * dayMs));
  flag('옛 상태(발주대기) 잔존 — 정리 대상', cnt(o => o.status === '발주대기'));

  // 4) 사용자 · 카탈로그
  log(`\n## 4. 사용자 · 카탈로그`);
  try {
    const profiles = await loadAll('profiles', 'role');
    const roles = profiles.reduce((a, p) => { const k = p.role || '(없음)'; a[k] = (a[k] || 0) + 1; return a; }, {});
    log(`- 사용자 역할별: ${Object.entries(roles).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    if ((roles.pending || 0) > 0) log(`  - ⚠️ 승인대기 ${roles.pending}명 — 관리화면 [승인대기]에서 처리`);
  } catch (e) { log(`- profiles 조회 에러: ${e.message}`); }
  for (const [t, label] of [['products', '상품'], ['user_prices', '사용자별 단가'], ['stock_receipts', '입고기록'], ['push_subscriptions', '푸시구독']]) {
    try { const rows = await loadAll(t, t === 'push_subscriptions' ? 'user_id' : 'id'); log(`- ${label}(${t}): ${rows.length}개`); }
    catch (e) { log(`- ${label}(${t}) 에러: ${e.message}`); }
  }

  // 5) 요약 판정
  log(`\n## 5. 종합`);
  const colMissing = Object.entries(colState).filter(([, v]) => v === false).map(([k]) => k);
  if (colMissing.length) log(`- ❌ 누락 컬럼: ${colMissing.join(', ')}`);
  else log(`- ✅ 점검한 컬럼 모두 존재`);
  if (!hasOmsPaid) log(`- ❌ oms_paid 없음 → 결제완료 체크 작동 안 함. SQL 실행 필요: \`alter table public.orders add column if not exists oms_paid boolean not null default false;\``);

  // 저장
  fs.mkdirSync('diagnostics', { recursive: true });
  const report = lines.join('\n') + '\n';
  fs.writeFileSync('diagnostics/latest.md', report, 'utf8');
  const stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
  fs.writeFileSync(`diagnostics/report-${stamp}.md`, report, 'utf8');
  console.log(`\n✅ 리포트 저장 완료: bot/diagnostics/latest.md`);
}

main().catch(e => { console.error('💥 진단 실패:', e); process.exit(1); });
