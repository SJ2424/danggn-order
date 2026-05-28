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

// 백업할 봇 시간표 (KST) — GitHub Actions와 동일 시각
// 운영: 08:00/11:50 발주 → 12:08/33/48 결제확인 → 12:10/35/50 알림 → 14·16시 송장
const JOBS = [
  // 발주 — 08:00(실제 08:01) + 11:50 오전 최종 (선반랙 + 카트)
  { title: '🤖 선반랙 발주 08:00 (백업)', hour: 8, minute: 1, body: { bot: 'register' } },
  { title: '🛒 카트 발주 08:00 (백업)',  hour: 8, minute: 1, body: { bot: 'cart' } },
  { title: '🤖 선반랙 발주 11:50 (백업·핵심)', hour: 11, minute: 50, body: { bot: 'register' } },
  { title: '🛒 카트 발주 11:50 (백업·핵심)',  hour: 11, minute: 50, body: { bot: 'cart' } },
  // 결제 확인 (선반랙 OMS 결제상태 읽기) 12:08 / 12:33 / 12:48 — 13시 마감 전 자동 확인
  { title: '💳 결제확인 12:08 (백업)', hour: 12, minute: 8,  body: { bot: 'tracking' } },
  { title: '💳 결제확인 12:33 (백업)', hour: 12, minute: 33, body: { bot: 'tracking' } },
  { title: '💳 결제확인 12:48 (백업·마감직전)', hour: 12, minute: 48, body: { bot: 'tracking' } },
  // 결제·입금 알림 12:10 / 12:35 / 12:50 (안 된 게 있으면 계속 상기)
  { title: '⏰ 결제 알림 12:10 (백업)', hour: 12, minute: 10, body: { bot: 'push' } },
  { title: '⏰ 결제 알림 12:35 (백업)', hour: 12, minute: 35, body: { bot: 'push' } },
  { title: '⏰ 마감 임박 12:50 (백업)', hour: 12, minute: 50, body: { bot: 'push' } },
  // 송장 — 선반랙 14:00 (송장 14시+) / 카트 16:00 (송장 15시+) → 둘 다 결제완료 자동 확정
  { title: '🚚 송장 14:00 선반랙 (백업)', hour: 14, minute: 0, body: { bot: 'tracking' } },
  { title: '🚚 송장 16:00 카트 (백업)',  hour: 16, minute: 0, body: { bot: 'cartTracking' } }
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

  const results = [];
  for (const j of JOBS) {
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

  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;

  return res.status(failCount === 0 ? 200 : 207).json({
    ok: failCount === 0,
    total: results.length,
    succeeded: okCount,
    failed: failCount,
    cleanedUp: existingDeleted,
    results,
    cronBotUrl,
    message: failCount === 0
      ? `✅ ${okCount}개 백업 cronjob 생성 완료${existingDeleted ? ` (기존 ${existingDeleted}개 정리)` : ''} — 이제 GitHub 지연돼도 정시에 발주됩니다`
      : `⚠️ ${okCount}개 성공 / ${failCount}개 실패 — 결과 상세 확인`
  });
}
