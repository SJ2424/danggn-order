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

  const isManual = process.env.MANUAL_RUN === 'true';
  // ⏰ KST 시간 가드 — 자동 cron만 (수동 실행은 항상 푸시)
  // GitHub Actions cron 지연 발화 보정용. 수동은 관리자가 의도한 거니 우회.
  if (!isManual){
    const kstHourStr = new Date().toLocaleString('en-US', {
      timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit'
    });
    const kstHour = parseInt(kstHourStr);
    // 12:50 cron이 1~10분 지연 발화하면 13:xx가 됨 — 14시까지 허용 (그 이상이면 의미 없음)
    if (kstHour < 11 || kstHour > 14){
      console.log(`⏭️  현재 KST ${kstHour}시 — 마감 알림 시간대(11~14) 아님. 푸시 skip (지연 발화 보정).`);
      return;
    }
  } else {
    console.log('📣 수동 실행 — 시간 가드 우회');
  }

  // 상태별 분리 카운트 (현 상태 사이클: 접수 → 발주완료 → 발송완료)
  // select('*') — oms_paid 컬럼이 아직 없어도(SQL 미실행) 에러 안 남
  const { data: orders, error: oErr } = await sb.from('orders').select('*');
  if (oErr) throw oErr;
  const all = orders || [];
  const recv      = all.filter(o => (o.status||'접수')==='접수').length;            // 봇이 곧 OMS 등록
  // OMS 결제 대기 = 봇이 등록(발주완료)했는데 내가 OMS에서 아직 결제 안 함 (oms_paid 없으면 결제 대기로 간주)
  // 직거래는 OMS 결제 대상 아님 → 제외
  const omsUnpaidList = all.filter(o => o.status==='발주완료' && !o.oms_paid && o.type !== '직거래');
  const ordered   = omsUnpaidList.length;
  const omsCost   = omsUnpaidList.reduce((s,o)=>s+(+o.cost_price||0)*(+o.qty||1),0);
  const shippedUnpaid = all.filter(o => o.status==='발송완료' && !o.paid).length;   // 발송됐는데 손님 미입금

  // 알림 보낼 필요 없는 경우
  if (recv === 0 && ordered === 0 && shippedUnpaid === 0){
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

  console.log(`📋 접수 ${recv} · OMS결제대기 ${ordered}(${omsCost}원) · 손님미입금 ${shippedUnpaid} · 구독 ${subs.length}건`);

  // 본문 — 짧고 한눈에 (잠금화면 2-3줄 가독성)
  // 12:02/12:45 발화 시점 = 11:50 자동 발주 후 → 접수 주문은 수동 발주 대상
  const lines = [];
  if (ordered > 0)       lines.push(`💳 결제 체크 ${ordered}건 · ${omsCost.toLocaleString('ko-KR')}원`);
  if (recv > 0)          lines.push(`🤖 수동 발주 필요 ${recv}건 (11:50 이후 입력)`);
  if (shippedUnpaid > 0) lines.push(`💰 손님 입금 대기 ${shippedUnpaid}건`);

  // 제목 — 가장 큰 액션 기준 (13:00 마감 = 그 후 다음날 발송)
  let title = '⏰ 13:00 마감 전 결제 체크';
  if (ordered === 0 && recv === 0 && shippedUnpaid > 0) title = '💰 손님 입금 확인';

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
