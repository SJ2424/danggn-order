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

  // ⏰ '결제 체크' 알림은 평일 12:10 1회만.
  //   cron-job.org이 12:10에 트리거하지만, 다른 시각(예전 12:35/12:50 잡 잔존 등)에
  //   트리거돼도 이 가드로 skip → "하루 한 번"만 발송. (수동/자동 모두 동일 적용)
  //   허용 창: 12:00~12:29 KST (12:10 발화 + 지연 여유 포함, 12:35/12:50은 제외)
  const hhmm = new Date().toLocaleString('en-US', {
    timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit'
  });                                    // 예: "12:10"
  const [kh, km] = hhmm.split(':').map(n => parseInt(n, 10));
  const kMin = kh * 60 + km;
  if (kMin < 12*60 || kMin > 12*60 + 29){
    console.log(`⏭️  현재 KST ${hhmm} — 결제 체크 알림 시간(12:00~12:29) 아님. 발송 skip.`);
    return;
  }
  console.log(`📣 결제 체크 알림 시간대 (KST ${hhmm}) — 발송 진행`);

  // 상태별 분리 카운트 (현 상태 사이클: 접수 → 발주완료 → 발송완료)
  // select('*') — oms_paid 컬럼이 아직 없어도(SQL 미실행) 에러 안 남
  const { data: orders, error: oErr } = await sb.from('orders').select('*');
  if (oErr) throw oErr;
  const all = orders || [];
  // 💳 결제 체크 = 봇이 발주(발주완료)했는데 아직 OMS에서 결제 안 한 것 (직거래 제외).
  //   13:00 마감 전 "내가 내야 할 돈" 확인용.
  //   사용자 요청: 이것만 알림 — 수동발주·손님입금 대기 알림은 제거(본인이 직접 확인).
  const omsUnpaidList = all.filter(o => o.status==='발주완료' && !o.oms_paid && o.type !== '직거래');
  const ordered = omsUnpaidList.length;
  const omsCost = omsUnpaidList.reduce((s,o)=>s+(+o.cost_price||0)*(+o.qty||1),0);

  // 결제할 게 없으면 알림 안 보냄 (다 결제했으면 조용)
  if (ordered === 0){
    console.log('결제 체크할 발주완료-미결제 0건 — 알림 생략');
    return;
  }

  // 관리자 구독 가져오기
  const { data: admins } = await sb.from('profiles').select('id').eq('role','admin');
  const adminIds = (admins||[]).map(a => a.id);
  if (adminIds.length === 0){ console.log('관리자 없음'); return; }

  const { data: subs, error: sErr } = await sb.from('push_subscriptions').select('*').in('user_id', adminIds);
  if (sErr) throw sErr;
  if (!subs || subs.length === 0){ console.log('등록된 구독 없음 (관리자가 [알림 켜기] 버튼을 한 번도 안 누른 상태)'); return; }

  console.log(`📋 OMS결제대기 ${ordered}건(${omsCost}원) · 구독 ${subs.length}건`);

  // 본문 — "결제 체크" 한 줄만 (사용자 요청: 평일 12:10 1회, 이것만)
  const payload = JSON.stringify({
    title: '⏰ 13:00 마감 전 결제 체크',
    body: `💳 결제 체크 ${ordered}건 · ${omsCost.toLocaleString('ko-KR')}원`,
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
      const reason = String(e.body || e.message || '');
      console.error(`  ❌ 실패 (${e.statusCode || '?'}): ${reason}`);
      // 죽은 구독 정리:
      //  · 410/404 — 구독 만료·해지됨
      //  · 400 VapidPkHashMismatch — 옛 VAPID 키로 등록된 구독. 현재 키로는 영영 실패하므로
      //    지워야 기기가 다음 접속 때 현재 키로 재구독(자동복구)됨. (성공한 구독은 건드리지 않음)
      const vapidMismatch = e.statusCode === 400 && /vapidpkhashmismatch|mismatch/i.test(reason);
      if (e.statusCode === 410 || e.statusCode === 404 || vapidMismatch){
        await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        dead++;
      }
    }
  }
  console.log(`\n📊 결과: 전송 ${sent}/${subs.length}건 · 죽은 구독 정리 ${dead}건(만료·키불일치)`);
}

main().catch(e => { console.error(e); process.exit(1); });
