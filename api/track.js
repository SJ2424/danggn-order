// 🚚 배송상태 조회 → DB 캐시 (Delivery Tracker GraphQL)
// 송장 있는 최근·미완료 주문의 배송상태를 가져와 orders.delivery_status에 저장.
// 카드에는 캐시된 상태가 자동 표시됨 → 손님 배송문의에 앱만 보고 바로 답변.
//
// 호출: POST /api/track  with Authorization: Bearer <supabase-jwt>  (admin 전용)
// 필요한 Vercel 환경변수:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY        — (이미 있음)
//   DELIVERY_TRACKER_API_KEY = "<clientId>:<clientSecret>"  — tracker.delivery에서 발급(무료)
//
// 택배사 자동감지: order.carrier가 있으면 그것만, 없으면 CARRIERS 순차 시도 후 성공한 걸 저장.
// 검증성: 결과/에러를 DB(delivery_status, delivery_status_at, carrier)에 남겨 자가진단으로 확인 가능.

import { createClient } from '@supabase/supabase-js';

const ENDPOINT = 'https://apis.tracker.delivery/graphql';

// 우리가 쓰는 택배사 (자동감지 순차 시도 순서). id는 Delivery Tracker carrier id.
const CARRIERS = [
  { id: 'kr.cjlogistics', name: 'CJ대한통운' },
  { id: 'kr.hanjin',      name: '한진택배' },
  { id: 'kr.chunilps',    name: '천일택배' },
];
const CARRIER_NAME = Object.fromEntries(CARRIERS.map(c => [c.id, c.name]));

const QUERY = `query Track($carrierId: ID!, $trackingNumber: String!) {
  track(carrierId: $carrierId, trackingNumber: $trackingNumber) {
    lastEvent { time status { code name } description }
  }
}`;

// 종료(더 조회 불필요) 상태 판별 — 이름에 '완료'/'배달'이 들어가면 종료로 간주
function isDelivered(statusName) {
  return /배송완료|배달완료|배달됨|delivered/i.test(statusName || '');
}

// 한 건 조회 — 성공 시 {ok, status, desc, time, carrier}, 실패 시 {ok:false, error}
async function trackOne(apiKey, carrierId, trackingNumber) {
  let res, json;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'TRACKQL-API-KEY ' + apiKey },
      body: JSON.stringify({ query: QUERY, variables: { carrierId, trackingNumber } }),
    });
    json = await res.json();
  } catch (e) {
    return { ok: false, error: 'network: ' + (e?.message || e) };
  }
  const ev = json?.data?.track?.lastEvent;
  if (ev && ev.status) {
    return {
      ok: true,
      status: ev.status.name || ev.status.code || '조회됨',
      desc: ev.description || '',
      time: ev.time || null,
      carrier: carrierId,
    };
  }
  // 이 택배사엔 없는 송장 → 자동감지에서 다음 택배사로 넘어가도록 notFound 표시
  const errMsg = json?.errors?.[0]?.message || '';
  return { ok: false, error: errMsg, notFound: /not\s*found|없|존재하지/i.test(errMsg) || !errMsg };
}

// carrier 자동감지 — 알려진 carrier 있으면 그것만, 없으면 순차 시도
async function trackAuto(apiKey, knownCarrier, trackingNumber) {
  const order = knownCarrier ? [knownCarrier, ...CARRIERS.map(c => c.id).filter(id => id !== knownCarrier)]
                             : CARRIERS.map(c => c.id);
  let lastErr = null;
  for (const cid of order) {
    const r = await trackOne(apiKey, cid, trackingNumber);
    if (r.ok) return r;
    lastErr = r.error;
    // 인증 오류 등 치명적 에러면 즉시 중단(다른 택배사 시도 무의미)
    if (/api.?key|unauthor|authentication|forbidden|TRACKQL/i.test(r.error || '')) {
      return { ok: false, error: r.error, fatal: true };
    }
  }
  return { ok: false, error: lastErr };
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용' });

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, DELIVERY_TRACKER_API_KEY } = process.env;
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (missing.length) return res.status(500).json({ error: `서버 설정 누락: ${missing.join(', ')}` });
  if (!DELIVERY_TRACKER_API_KEY) {
    return res.status(400).json({
      error: '배송조회 API 키 미설정',
      hint: 'tracker.delivery에서 무료 키 발급 후 Vercel 환경변수 DELIVERY_TRACKER_API_KEY = "clientId:clientSecret" 추가 → 재배포',
      needsSetup: true,
    });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  // 인증 — admin 전용
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: '로그인 토큰 없음' });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) return res.status(401).json({ error: '로그인 정보 무효 — 다시 로그인' });
  const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!prof || prof.role !== 'admin') return res.status(403).json({ error: '관리자 권한 필요' });

  // 조회 대상 — 송장 있고, 아직 배송완료 아니고, 최근 14일 내 (오래된 건 이미 도착, 호출 절약)
  const since = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const { data: orders, error: qErr } = await sb
    .from('orders')
    .select('id, tracking, carrier, delivery_status, created_at, shipped_at, type')
    .not('tracking', 'is', null)
    .neq('type', '직거래')
    .or(`created_at.gte.${since},shipped_at.gte.${since}`)
    .limit(80);
  if (qErr) return res.status(500).json({ error: 'DB 조회 실패: ' + qErr.message });

  const targets = (orders || []).filter(o => o.tracking && !isDelivered(o.delivery_status));
  let checked = 0, updated = 0, delivered = 0, failed = 0, firstError = null;

  for (const o of targets) {
    checked++;
    const r = await trackAuto(DELIVERY_TRACKER_API_KEY, o.carrier, String(o.tracking).trim());
    if (r.fatal) { firstError = r.error; failed = targets.length - updated; break; } // 키 문제 → 전체 중단
    if (r.ok) {
      const patch = { delivery_status: r.status, delivery_status_at: new Date().toISOString(), carrier: r.carrier };
      const { error: uErr } = await sb.from('orders').update(patch).eq('id', o.id);
      if (uErr) { failed++; if (!firstError) firstError = 'DB쓰기: ' + uErr.message; }
      else { updated++; if (isDelivered(r.status)) delivered++; }
    } else {
      failed++; if (!firstError) firstError = r.error || '조회 결과 없음';
    }
  }

  return res.status(200).json({
    ok: true,
    checked, updated, delivered, failed,
    firstError,
    message: `${checked}건 조회 · ${updated}건 갱신 · 배송완료 ${delivered}건` + (failed ? ` · 실패 ${failed}건` : ''),
  });
}
