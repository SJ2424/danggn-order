// 12:30 KST 평일 자동 푸시 알림 봇
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
} = process.env;

for (const [k,v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT })){
  if (!v) { console.error(`❌ 환경변수 누락: ${k}`); process.exit(1); }
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function main(){
  console.log('🔔 푸시 알림 봇 시작');

  // 상태별 분리 카운트
  const { data: orders, error: oErr } = await sb.from('orders').select('id, status, paid');
  if (oErr) throw oErr;
  const all = orders || [];
  const recv      = all.filter(o => (o.status||'접수')==='접수').length;         // 봇이 OMS 등록 예정
  const waitingPay= all.filter(o => o.status==='발주대기').length;               // 본인 결제 필요!
  const ordered   = all.filter(o => o.status==='발주완료' && !o.paid).length;    // 결제됨, 송장 대기
  const shippedUnpaid = all.filter(o => o.status==='발송완료' && !o.paid).length;// 발송됐는데 손님 미입금

  // 알림 보낼 필요 없는 경우 (행동 필요 없음)
  if (recv === 0 && waitingPay === 0 && shippedUnpaid === 0){
    console.log('알림 보낼 내용 없음 (행동 필요한 주문 0건)');
    return;
  }

  // 관리자 구독 가져오기
  const { data: admins } = await sb.from('profiles').select('id').eq('role','admin');
  const adminIds = (admins||[]).map(a => a.id);
  if (adminIds.length === 0){ console.log('관리자 없음'); return; }

  const { data: subs, error: sErr } = await sb.from('push_subscriptions').select('*').in('user_id', adminIds);
  if (sErr) throw sErr;
  if (!subs || subs.length === 0){ console.log('등록된 구독 없음 (관리자가 [알림 켜기] 버튼을 한 번도 안 누른 상태)'); return; }

  console.log(`📋 접수 ${recv} · 발주대기(결제필요) ${waitingPay} · 발주완료(송장대기) ${ordered} · 발송완료-미입금 ${shippedUnpaid} · 구독 ${subs.length}건`);

  // 본문 — 가장 시급한 액션을 맨 위에
  const lines = [];
  if (waitingPay > 0) lines.push(`🔴 결제 필요 ${waitingPay}건 — OMS 일괄주문+송금`);
  if (recv > 0)       lines.push(`🟠 접수 ${recv}건 — 봇이 곧 OMS 등록`);
  if (shippedUnpaid > 0) lines.push(`💰 손님 미입금 ${shippedUnpaid}건 — 입금 확인 필요`);

  // 제목 — 가장 큰 액션 기준
  let title = '🚨 발주 마감 12:55';
  if (waitingPay === 0 && recv === 0 && shippedUnpaid > 0) title = '💰 손님 미입금 확인';

  const payload = JSON.stringify({
    title,
    body: lines.join('\n'),
    tag: 'deadline-' + new Date().toISOString().slice(0,10),
    url: '/'
  });

  let sent = 0, dead = 0;
  for (const s of subs){
    try {
      await webpush.sendNotification({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth }
      }, payload);
      sent++;
      console.log(`  ✅ 전송: ${s.endpoint.slice(0, 60)}...`);
    } catch(e){
      console.error(`  ❌ 실패 (${e.statusCode || '?'}): ${e.body || e.message}`);
      // 만료된 구독 정리
      if (e.statusCode === 410 || e.statusCode === 404){
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        dead++;
      }
    }
  }
  console.log(`\n📊 결과: 전송 ${sent}/${subs.length}건 · 만료 정리 ${dead}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
