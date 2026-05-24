// 월별 자동 백업 — orders 테이블 전체를 CSV로 저장
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY){ console.error('환경변수 누락'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth:{ persistSession:false } });

function escc(v){ return '"' + String(v==null?'':v).replace(/"/g,'""') + '"'; }

async function main(){
  // 전체 주문 불러오기 (페이지네이션으로 대용량 대비)
  let all = [];
  let from = 0;
  const PAGE = 1000;
  while (true){
    const { data, error } = await sb.from('orders').select('*').order('created_at',{ ascending:true }).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`📦 ${all.length}건 백업 중...`);

  const head = ['생성일시(UTC)','날짜','휴대폰','구매자닉네임','성함','연락처','주소','상품','색상','수량','거래방식','판매금액','입금','입금자명','상태','송장','원가(매입가)','납품가','발송시각','입력자ID'];
  const rows = all.map(o => [
    o.created_at, o.date, o.phone, o.nick, o.name, o.tel, o.addr, o.product, o.color, o.qty, o.type,
    o.amount, o.paid ? '입금완료' : '미입금', o.paid_by, o.status || '접수', o.tracking,
    o.cost_price, o.rep_price, o.shipped_at, o.created_by
  ].map(escc).join(','));

  const csv = '﻿' + [head.join(','), ...rows].join('\n');

  // 파일명: KST 기준 YYYY-MM (어제 자정 시점)
  const kst = new Date(Date.now() + 9*3600*1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth()+1).padStart(2,'0');
  const dir = 'backups';
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${dir}/${y}-${m}.csv`;
  fs.writeFileSync(filename, csv, 'utf8');
  console.log(`✅ 저장: ${filename} (${(csv.length/1024).toFixed(1)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
