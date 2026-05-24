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

  // 처리 대기 주문 수 (접수 + 발주대기)
  const { data: orders, error: oErr } = await sb.from('orders').select('id, status, paid');
  if (oErr) throw oErr;
  const all = orders || [];
  const pending = all.filter(o => (o.status||'접수')==='접수' || o.status==='발주대기').length;
  const unpaid = all.filter(o => !o.paid && (o.status==='발주완료' || o.status==='발송완료')).length;

  if (pending === 0 && unpaid === 0){
    console.log('알림 보낼 내용 없음 (대기 0, 미입금 0)');
    return;
  }

  // 관리자 구독 가져오기
  const { data: admins } = await sb.from('profiles').select('id').eq('role','admin');
  const adminIds = (admins||[]).map(a => a.id);
  if (adminIds.length === 0){ console.log('관리자 없음'); return; }

  const { data: subs, error: sErr } = await sb.from('push_subscriptions').select('*').in('user_id', adminIds);
  if (sErr) throw sErr;
  if (!subs || subs.length === 0){ console.log('등록된 구독 없음 (관리자가 [알림 켜기] 버튼을 한 번도 안 누른 상태)'); return; }

  console.log(`📋 처리 대기 ${pending}건 · 미입금(발주됨) ${unpaid}건 · 구독 ${subs.length}건`);

  // 알림 내용
  const bodyParts = [];
  if (pending > 0) bodyParts.push(`처리 대기 ${pending}건`);
  if (unpaid > 0) bodyParts.push(`미입금 ${unpaid}건`);
  const payload = JSON.stringify({
    title: '🚨 발주 마감 임박',
    body: bodyParts.join(' · ') + '\n12:55 OMS 일괄주문 + 송금 필요',
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
