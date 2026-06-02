// 🤖 cron-job.org 자동 셋업 — admin 클릭 한 번에 9개 백업 job 생성
// 사용자 입력: cron-job.org API key (한 번만)
//
// POST /api/setup-cron-jobs
// Headers: Authorization: Bearer <supabase JWT>
// Body: { apiKey: "..." }  ← cron-job.org에서 발급한 키
//
// 동작:
//   1. admin 권한 확인
//   2. 우리 CRON_SECRET 환경변수 가져옴
//   3. 9개 job을 cron-job.org REST API로 자동 생성
//   4. 결과 요약 반환

import { createClient } from '@supabase/supabase-js';

// 🎯 핵심 백업만 (KST) — cron-job.org 무료 API는 분당 5건 제한이라, 한 번에 다 생성되도록
//    13:00 마감 전 "반드시" 떠야 하는 것만 추림: 마감 알림 push 3개 + 11:50 발주 2개.
//    (이미 있는 잡은 건너뛰므로 — 아래 skip-existing — 보통 push 3개만 새로 생성됨)
const JOBS = [
  // ⏰ 마감 알림 (사용자 핵심 — GitHub 지연되면 13시 마감 알림을 놓침)
  { title: '⏰ 결제 알림 12:10 (백업)', hour: 12, minute: 10, body: { bot: 'push' } },
  { title: '⏰ 결제 알림 12:35 (백업)', hour: 12, minute: 35, body: { bot: 'push' } },
  { title: '⏰ 마감 임박 12:50 (백업)', hour: 12, minute: 50, body: { bot: 'push' } },
  // 🤖 11:50 오전 최종 발주 (지연되면 주문이 13시 마감 못 맞춤 — 핵심)
  { title: '🤖 선반랙 발주 11:50 (백업·핵심)', hour: 11, minute: 50, body: { bot: 'register' } },
  { title: '🛒 카트 발주 11:50 (백업·핵심)',  hour: 11, minute: 50, body: { bot: 'cart' } }
  // (결제확인·송장·08:00 발주 등 부차적인 백업은 제외 — 무료 API 분당 5건 제한 안에 들도록
  //  핵심만 남김. GitHub 예약 + 수동 버튼으로 충분. 이미 만들어둔 잡이 있으면 그대로 둬도 작동함)
];

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase 환경변수 미설정' });
  }
  if (!CRON_SECRET) {
    return res.status(500).json({
      error: 'CRON_SECRET 환경변수가 Vercel에 등록 안 됨',
      hint: '먼저 Vercel Settings → Environment Variables에 CRON_SECRET 추가 후 재배포 필요'
    });
  }

  // admin JWT 검증
  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: '로그인 토큰 없음' });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) {
    return res.status(401).json({ error: '로그인 정보 유효하지 않음' });
  }
  const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!prof || prof.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한 필요' });
  }

  // body
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}
  const apiKey = (body.apiKey || '').trim();
  const mode = body.mode || 'create';  // 'cleanup' | 'create'
  if (!apiKey) {
    return res.status(400).json({ error: 'cron-job.org API key 필요', hint: 'body에 { "apiKey": "..." }' });
  }

  const cronBotUrl = `https://${req.headers.host || 'danggn-order.vercel.app'}/api/cron-bot`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // 429(요청 한도) 만나면 backoff 후 재시도 — cron-job.org 무료플랜 rate limit 대응
  const cronFetch = async (url, opts, tries = 3) => {
    let last;
    for (let i = 0; i < tries; i++) {
      last = await fetch(url, opts);
      if (last.status !== 429) return last;
      await sleep(3000 * (i + 1));  // 3s → 6s → 9s
    }
    return last;
  };
  // 상태코드 → 사용자 친화 메시지 (429를 '인증 실패'로 오표기하던 버그 수정)
  const apiErrMsg = (status) =>
    status === 429 ? 'cron-job.org 요청 한도 초과(429) — 1~2분 기다렸다가 다시 시도하세요 (연속 클릭하면 더 막힙니다)'
    : (status === 401 || status === 403) ? `cron-job.org 인증 실패(${status}) — API 키가 틀렸거나 만료됨`
    : `cron-job.org 응답 오류(${status})`;

  // ① cleanup 모드 — 기존 "백업" title job 모두 삭제 후 종료 (시간 분리)
  if (mode === 'cleanup') {
    let existingDeleted = 0;
    try {
      const listRes = await cronFetch('https://api.cron-job.org/jobs', {
        headers: { 'Authorization': 'Bearer ' + apiKey }
      });
      if (!listRes.ok) {
        const t = await listRes.text().catch(() => '');
        return res.status(502).json({ error: apiErrMsg(listRes.status), status: listRes.status, detail: t.slice(0, 200) });
      }
      const listJson = await listRes.json();
      const existing = (listJson.jobs || []).filter(j => j.title && /백업/.test(j.title));
      for (const j of existing) {
        try {
          await cronFetch('https://api.cron-job.org/jobs/' + j.jobId, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + apiKey }
          });
          existingDeleted++;
        } catch {}
        await sleep(900);
      }
    } catch(e) {
      return res.status(502).json({ error: 'cleanup 실패: ' + e.message });
    }
    return res.status(200).json({ ok: true, mode: 'cleanup', cleanedUp: existingDeleted });
  }

  // create 모드 — cleanup은 별도 호출에서 이미 처리됨
  const existingDeleted = 0;

  // ② 12개 job 순차 생성 (rate limit 회피)
  // cron-job.org 무료 plan = 1 req/sec → 1.1초 간격 + 429시 2.5초 대기 후 재시도 1회
  const createJob = async (j) => {
    return fetch('https://api.cron-job.org/jobs', {
      method: 'PUT',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        job: {
          title: j.title,
          url: cronBotUrl,
          enabled: true,
          saveResponses: false,
          schedule: {
            timezone: 'Asia/Seoul',
            hours: [j.hour], minutes: [j.minute],
            mdays: [-1], months: [-1],
            wdays: [1, 2, 3, 4, 5]
          },
          requestMethod: 1,
          extendedData: {
            headers: {
              'X-Cron-Secret': CRON_SECRET,
              'Content-Type': 'application/json',
              'User-Agent': 'cron-job-org-backup'
            },
            body: JSON.stringify(j.body)
          }
        }
      })
    });
  };

  // 이미 만들어진 백업 job은 건너뜀 — rate limit(분당 5건)으로 일부만 됐어도
  // 다음 클릭에 "빠진 것만" 채워 누적 완성. (예전엔 매번 지우고 다시 만들어서
  // 우선순위 낮은 push 잡이 계속 제한에 걸려 실패하던 원인)
  let existingTitles = new Set();
  try {
    const listRes = await cronFetch('https://api.cron-job.org/jobs', {
      headers: { 'Authorization': 'Bearer ' + apiKey }
    });
    if (listRes.ok) {
      const lj = await listRes.json().catch(() => ({}));
      existingTitles = new Set((lj.jobs || []).map(x => x.title));
    }
  } catch {}

  const results = [];
  for (const j of JOBS) {
    if (existingTitles.has(j.title)) {      // 이미 있음 → 건너뜀 (생성 호출 안 함)
      results.push({ title: j.title, ok: true, skipped: true });
      continue;
    }
    let attempt = 0, lastErr = null;
    while (attempt < 3) {  // 최대 3회 시도 (1차 + retry 2회)
      attempt++;
      try {
        const r = await createJob(j);
        const text = await r.text().catch(() => '');
        if (r.ok) {
          let jobId = null;
          try { jobId = JSON.parse(text)?.jobId; } catch {}
          results.push({ title: j.title, ok: true, jobId });
          lastErr = null;
          break;
        }
        // 429 rate limit → backoff (2.5초). 12개라 시간 빡빡해서 retry 1회만
        if (r.status === 429 && attempt < 2) {
          await sleep(2500);
          continue;
        }
        let detail = text.slice(0, 200);
        try { detail = JSON.parse(text).message || detail; } catch {}
        // 429/401/403은 친화 메시지로 (원시 detail보다 알아보기 쉬움)
        const friendly = (r.status === 429 || r.status === 401 || r.status === 403) ? apiErrMsg(r.status) : detail;
        lastErr = { status: r.status, error: friendly };
        break;
      } catch (e) {
        lastErr = { error: e.message };
        break;
      }
    }
    if (lastErr) results.push({ title: j.title, ok: false, ...lastErr });
    await sleep(1100);  // 다음 job 전 1.1초 대기 (12개 × 1.1 ≈ 13초 — Vercel 60초 안)
  }

  const created  = results.filter(r => r.ok && !r.skipped).length;
  const skipped  = results.filter(r => r.skipped).length;
  const okCount  = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;

  return res.status(failCount === 0 ? 200 : 207).json({
    ok: failCount === 0,
    total: results.length,
    succeeded: okCount,
    created,
    skipped,
    failed: failCount,
    cleanedUp: existingDeleted,
    results,
    cronBotUrl,
    message: failCount === 0
      ? `✅ 백업 cronjob 준비 완료 (새로 ${created}개${skipped ? ` + 기존 ${skipped}개` : ''}) — 이제 GitHub 지연돼도 정시에 발주/알림`
      : `⚠️ 새로 ${created}개${skipped ? ` (기존 ${skipped}개)` : ''} · ${failCount}개 남음 — 1~2분 뒤 [🔁 다시 시도] 누르면 나머지만 채워집니다`
  });
}
