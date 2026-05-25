// Vercel Serverless Function — 관리자가 봇을 즉시 실행
// 호출: POST /api/run-bot  with Authorization: Bearer <supabase-jwt>
// Body: { bot: 'register' | 'cart' | 'tracking' }  (기본 'register')
//
// 흐름:
//   1. 헤더의 Supabase JWT 확인 — 진짜 로그인된 사용자인가
//   2. profiles 테이블에서 role='admin'인가 확인
//   3. GitHub workflow_dispatch API 호출 → 봇 즉시 실행
//
// 필요한 Vercel 환경변수:
//   SUPABASE_URL          — Supabase 프로젝트 URL
//   SUPABASE_SERVICE_KEY  — Supabase service_role 키
//   GITHUB_TOKEN          — GitHub PAT (workflow 권한)
//   GITHUB_REPO           — (선택) 기본 'SJ2424/danggn-order'

import { createClient } from '@supabase/supabase-js';

const BOT_MAP = {
  register:     'register-orders.yml',     // 선반랙 OMS 등록
  cart:         'register-cart.yml',       // 카트사이트 등록
  tracking:     'fetch-tracking.yml',      // 선반랙 송장 수집
  cartTracking: 'fetch-cart-tracking.yml', // 카트 송장 수집
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 허용' });
  }

  // 환경변수 확인
  const SUPABASE_URL         = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const GITHUB_TOKEN         = process.env.GITHUB_TOKEN;
  const GITHUB_REPO          = process.env.GITHUB_REPO || 'SJ2424/danggn-order';

  const missing = [];
  if (!SUPABASE_URL)         missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!GITHUB_TOKEN)         missing.push('GITHUB_TOKEN');
  if (missing.length) {
    return res.status(500).json({
      error: `서버 설정 누락: ${missing.join(', ')} — Vercel 환경변수에 추가하세요`
    });
  }

  // JWT 추출
  const authHeader = req.headers.authorization || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: '로그인 토큰 없음' });

  // Supabase 관리자 클라이언트
  const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 1) JWT 검증 + 유저 정보
  const { data: { user }, error: authErr } = await sbAdmin.auth.getUser(jwt);
  if (authErr || !user) {
    return res.status(401).json({ error: '로그인 정보가 유효하지 않습니다 — 다시 로그인하세요' });
  }

  // 2) 관리자 권한 확인
  const { data: prof, error: profErr } = await sbAdmin
    .from('profiles').select('role').eq('id', user.id).single();
  if (profErr || !prof) {
    return res.status(403).json({ error: '프로필 정보를 찾을 수 없습니다' });
  }
  if (prof.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  }

  // 3) 어떤 봇?
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {}
  const botKey  = body.bot || 'register';
  const botFile = BOT_MAP[botKey];
  if (!botFile) {
    return res.status(400).json({ error: `알 수 없는 봇: ${botKey}` });
  }

  // 4) GitHub workflow_dispatch
  const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/workflows/${botFile}/dispatches`;
  const ghRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'danggn-order-app'
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { dry_run: 'false' }
    })
  });

  if (!ghRes.ok) {
    const text = await ghRes.text().catch(() => '');
    return res.status(502).json({
      error: `GitHub API 호출 실패 (${ghRes.status})`,
      detail: text.slice(0, 400),
      hint: ghRes.status === 401
        ? 'GITHUB_TOKEN이 잘못됐거나 만료됨'
        : ghRes.status === 404
        ? '워크플로우 파일명 또는 GITHUB_REPO 확인'
        : ghRes.status === 422
        ? '워크플로우가 main 브랜치에 없거나 inputs 불일치'
        : ''
    });
  }

  return res.status(200).json({
    ok: true,
    bot: botKey,
    file: botFile,
    user: user.email,
    message: '✅ 봇 실행 요청 보냄. 2~3분 후 결과가 자동 반영됩니다.'
  });
}
