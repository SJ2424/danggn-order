// 새 VAPID 키 페어 발급 — admin only
// 사용자가 클릭 한 번이면 새 키 받음 → GitHub Secrets + Vercel 환경변수에 등록

import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Supabase 환경변수 누락' });
  }

  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: '로그인 토큰 없음' });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // 사용자 JWT 검증
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) {
    return res.status(401).json({ error: '로그인 정보가 유효하지 않음' });
  }

  // admin 권한 확인
  const { data: prof } = await sb.from('profiles').select('role').eq('id', user.id).single();
  if (!prof || prof.role !== 'admin') {
    return res.status(403).json({ error: '관리자 권한 필요' });
  }

  // 새 VAPID 키 페어 발급
  const keys = webpush.generateVAPIDKeys();
  const subject = 'mailto:' + (user.email || 'admin@danggn-order.app');

  return res.status(200).json({
    ok: true,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    subject,
    instructions: '아래 3개 값을 GitHub Secrets(update) + Vercel 환경변수(add)에 같은 이름으로 등록 후 재배포'
  });
}
