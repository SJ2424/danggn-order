// 72시간+ 미입금 알림 봇 (매일 오전 10시 KST)
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
for (const [k,v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT })){
  if (!v){ console.error('❌ 환경변수 누락: ' + k); process.exit(1); }
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth:{ persistSession:false } });

async function main(){
  const cutoff = new Date(Date.now() - 72*3600*1000).toISOString();
  const { data: orders, error } = await sb.from('orders')
    .select('id, created_by, amount, name')
    .eq('paid', false)
    .eq('status', '발송완료')
    .lt('shipped_at', cutoff);
  if (error){ console.error('주문 조회 실패:', error); process.exit(1); }
  if (!orders || orders.length === 0){ console.log('✅ 72H+ 미입금 없음. 종료.'); return; }

  // 사용자별 집계 (입력자 본인용 — 관리자는 화면에서만 확인, 푸시 X)
  const byUser = {};
  orders.forEach(o => {
    const uid = o.created_by;
    if (!uid) return;
    if (!byUser[uid]) byUser[uid] = { count: 0, total: 0 };
    byUser[uid].count++;
    byUser[uid].total += (+o.amount || 0);
  });

  // 관리자 ID들 — 제외 대상
  const { data: admins } = await sb.from('profiles').select('id').eq('role', 'admin');
  const adminIds = new Set((admins||[]).map(a => a.id));

  // 알림 받을 사용자 = 영향받은 입력자(관리자 제외)
  const recipients = [...Object.keys(byUser)].filter(uid => !adminIds.has(uid));
  if (recipients.length === 0){ console.log('알림 대상 입력자 없음 (관리자만 해당). 종료.'); return; }
  const { data: subs } = await sb.from('push_subscriptions').select('*').in('user_id', recipients);
  if (!subs || subs.length === 0){ console.log('구독 없음. 종료.'); return; }

  let sent = 0, dropped = 0;
  for (const s of subs){
    const g = byUser[s.user_id];
    if (!g) continue;
    const count = g.count;
    const total = g.total;
    const payload = JSON.stringify({
      title: `💸 입금 대기 ${count}건 (3일 지남)`,
      body: `합계 ${total.toLocaleString('ko-KR')}원 — 손님 입금 확인 필요`,
      url: '/',
      tag: 'overdue-unpaid'
    });
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
      sent++;
    } catch(e){
      if (e.statusCode === 410 || e.statusCode === 404){
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        dropped++;
      }
      console.error(`Failed (${s.endpoint.slice(-20)}): ${e.message}`);
    }
  }
  console.log(`📨 ${sent} push 전송 / ${dropped} 만료 정리`);
}

main().catch(e => { console.error(e); process.exit(1); });
