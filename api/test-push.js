// 실제 Web Push 한 발 발송 — 사용자가 알림 작동 여부를 잠금화면에서 검증
// POST /api/test-push with Authorization: Bearer <supabase JWT>
// 본인이 등록한 모든 endpoint(아이폰·아이패드·노트북 등)로 즉시 푸시 전송

import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용' });
  }

  const {
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
  } = process.env;
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!VAPID_PUBLIC_KEY) missing.push('VAPID_PUBLIC_KEY');
  if (!VAPID_PRIVATE_KEY) missing.push('VAPID_PRIVATE_KEY');
  if (!VAPID_SUBJECT) missing.push('VAPID_SUBJECT');
  if (missing.length) {
    return res.status(500).json({ error: `Vercel 환경변수 누락: ${missing.join(', ')}` });
  }

  const jwt = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return res.status(401).json({ error: '로그인 토큰 없음' });

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt);
  if (authErr || !user) {
    return res.status(401).json({ error: '로그인 정보가 유효하지 않음 — 다시 로그인' });
  }

  // 본인의 구독 모두 조회 (다중 기기 지원)
  const { data: subs, error: sErr } = await sb
    .from('push_subscriptions')
    .select('*')
    .eq('user_id', user.id);
  if (sErr) {
    return res.status(500).json({ error: 'DB 조회 실패: ' + sErr.message });
  }
  if (!subs || subs.length === 0) {
    return res.status(404).json({
      error: '등록된 알림 기기가 없습니다',
      hint: '먼저 화면의 [🔔 알림 켜기] 버튼을 눌러서 이 기기를 등록하세요'
    });
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({
    title: '🔔 알림 테스트 성공',
    body: '이 알림이 보이면 잘 작동하는 거예요! 마감 임박 알림도 이런 식으로 옵니다.',
    tag: 'test-push-' + Date.now(),
    url: '/'
  });

  let sent = 0, expired = 0, errors = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        // 만료된 구독 — 자동 정리
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        expired++;
      } else {
        errors.push(`HTTP ${e.statusCode || '?'}: ${e.message?.slice(0, 100)}`);
      }
    }
  }

  return res.status(200).json({
    ok: sent > 0,
    sent,
    total: subs.length,
    expired,
    errors,
    message: sent > 0
      ? `✅ ${sent}개 기기에 테스트 알림 전송됨 — 2~5초 안에 잠금화면 확인`
      : expired > 0
        ? `⚠️ 등록된 ${expired}개 구독이 모두 만료 — 알림을 다시 켜야 함`
        : `❌ 전송 실패 — VAPID 키 mismatch 의심`
  });
}
