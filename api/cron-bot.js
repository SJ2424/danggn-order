// 외부 cron (cron-job.org 등) → GitHub workflow_dispatch 라우팅
// GitHub Actions 무료 cron이 지연될 때 백업으로 작동
// 인증: X-Cron-Secret header (또는 ?secret= query)
//
// 사용:
//   POST /api/cron-bot
//   Header: X-Cron-Secret: <CRON_SECRET 환경변수 값>
//   Body: {"bot": "register" | "cart" | "tracking" | "cartTracking" | "push" | "overdue"}
// 또는 (GET도 지원):
//   GET /api/cron-bot?secret=...&bot=register

const BOT_MAP = {
  register:     'register-orders.yml',
  cart:         'register-cart.yml',
  tracking:     'fetch-tracking.yml',
  cartTracking: 'fetch-cart-tracking.yml',
  push:         'send-push.yml',
  overdue:      'check-overdue.yml'
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // CORS (cron-job.org 등 외부 서비스 호환)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'X-Cron-Secret, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET 환경변수 미설정' });
  }

  // 인증
  const provided = req.headers['x-cron-secret'] || (req.query && req.query.secret) || '';
  if (provided !== CRON_SECRET) {
    return res.status(401).json({ error: '인증 실패 (X-Cron-Secret header 또는 ?secret= 필요)' });
  }

  // 봇 종류
  let botKey = (req.query && req.query.bot) || 'register';
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      if (body.bot) botKey = body.bot;
    } catch {}
  }
  const botFile = BOT_MAP[botKey];
  if (!botFile) {
    return res.status(400).json({ error: `알 수 없는 봇: ${botKey}`, validOptions: Object.keys(BOT_MAP) });
  }

  // 주말 보호 — 평일 봇은 토/일 skip
  // (cron-job.org에서 일정 잘못 잡혔거나, 봇 시간 외 호출 방지)
  const kstDow = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' });
  const isWeekend = kstDow === 'Sat' || kstDow === 'Sun';
  const weekdayOnly = ['register', 'cart', 'tracking', 'cartTracking', 'push'];
  if (isWeekend && weekdayOnly.includes(botKey)) {
    return res.status(200).json({ ok: true, skipped: true, reason: '주말 — 평일 전용 봇 skip', bot: botKey });
  }

  // GitHub workflow_dispatch
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO  = process.env.GITHUB_REPO || 'SJ2424/danggn-order';
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 환경변수 미설정' });
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${botFile}/dispatches`;
  const ghRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'danggn-order-cron-backup'
    },
    body: JSON.stringify({ ref: 'main', inputs: { dry_run: 'false' } })
  });

  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => '');
    return res.status(502).json({
      error: `GitHub API 호출 실패 (${ghRes.status})`,
      detail: text.slice(0, 300)
    });
  }

  return res.status(200).json({
    ok: true,
    bot: botKey,
    file: botFile,
    triggered_at: new Date().toISOString(),
    message: `✅ ${botKey} 백업 트리거 성공`
  });
}
