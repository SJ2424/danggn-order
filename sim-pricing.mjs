// 다중 판매자 가격·정산 로직 백테스트 시뮬레이터
// ─ 목적: 라이브 DB를 건드리지 않고, snapshot_prices 트리거 + 앱 장부/정산/마진 계산을
//   그대로 재현해 여러 판매자 시나리오를 수치로 검증한다.
// ─ 기대값은 손으로 계산해 assert에 직접 박았다(같은 함수로 자기검증하는 순환 방지).

let PASS = 0, FAIL = 0;
function eq(label, got, want){
  const ok = got === want;
  console.log(`${ok ? '✅' : '❌'} ${label} → ${got}${ok ? '' : `  (기대: ${want})`}`);
  ok ? PASS++ : FAIL++;
}

// ───────── 테스트 데이터 ─────────
const PRODUCTS = [
  { name:'핸드카트', color:'블랙', default_cost:28000, default_cost_pickup:26000, default_rep_price:36000 },
];
const PROFILES = {
  admin:   { id:'admin', role:'admin' },
  서진:    { id:'서진', role:'input' },   // 단가 31000(택배)/29000(직거래)
  미정:    { id:'미정', role:'input' },   // 단가 32000(택배), 직거래 미설정 → 32000
  신입:    { id:'신입', role:'input' },   // 단가 미설정 (가입만)
};
const USER_PRICES = [
  { user_id:'서진', product_name:'핸드카트', color:'블랙', rep_price:31000, rep_price_pickup:29000 },
  { user_id:'미정', product_name:'핸드카트', color:'블랙', rep_price:32000, rep_price_pickup:null },
];

// ───────── snapshot_prices 트리거 재현 (OPERATIONS.md §4 그대로) ─────────
const norm = c => (c||'');
function snapshotPrices(o){
  const prod = PRODUCTS.find(p => p.name===o.product && norm(p.color)===norm(o.color));
  // cost_price: 거래 type 분기
  let cost;
  if(o.type === '직거래') cost = (prod.default_cost_pickup ?? prod.default_cost);
  else                    cost = prod.default_cost;
  cost = cost ?? 0;
  // rep_price: 1) user_prices(type분기) 2) admin amount/qty 3) settle_basis cost 4) default_rep_price
  let rep = null;
  const up = USER_PRICES.find(u => u.user_id===o.created_by && u.product_name===o.product && norm(u.color)===norm(o.color));
  if(up){
    rep = (o.type==='직거래') ? (up.rep_price_pickup ?? up.rep_price) : up.rep_price;
  } else {
    const prof = PROFILES[o.created_by];
    const role = prof?.role, basis = prof?.settle_basis || 'rep', margin = prof?.settle_margin || 0;
    if(role==='admin' && o.amount!=null && (o.qty||1)>0) rep = Math.round(o.amount / (o.qty||1));
    else if(basis==='cost') rep = cost + margin;
    else rep = prod.default_rep_price;
  }
  rep = rep ?? o.amount ?? 0;
  return { ...o, cost_price:cost, rep_price:rep };
}

// ───────── 판매자 장부 재현 (index.html renderLedger input 분기) ─────────
function sellerLedger(orders){
  const received = orders.reduce((s,o)=> s + (+o.amount||0), 0);
  const settleUnsettled = orders.filter(o=>!o.settled).reduce((s,o)=> s + (+o.rep_price||0)*(+o.qty||1), 0);
  const totalRep = orders.reduce((s,o)=> s + (+o.rep_price||0)*(+o.qty||1), 0);
  const margin = received - totalRep;
  return { received, settleUnsettled, margin };
}
// ───────── 관리자 정산 집계 재현 (computeSettle) ─────────
function adminSettle(orders, uid){
  return orders.filter(o=>!o.settled && o.created_by===uid && o.created_by!=='admin')
               .reduce((s,o)=> s + (+o.rep_price||0)*(+o.qty||1), 0);
}
// ───────── 카드 마진 재현 (cardHtml, 관리자 시야) ─────────
function cardMargin(o, ADMIN_IDS){
  const q = +o.qty||1;
  const rev = (ADMIN_IDS.has(o.created_by) && o.amount) ? +o.amount : ((+o.rep_price||0)*q);
  const cst = (+o.cost_price||0)*q;
  return rev - cst;
}
// ───────── saveEdit의 거래방식 변경 처리 (buggy=현재, fixed=수정안) ─────────
function saveEditTypeChange(o, newType, { fixed }){
  const out = { ...o, type:newType };
  const isAdminOrder = PROFILES[o.created_by]?.role === 'admin';
  // cost_price: 카탈로그에서 재계산 (양쪽 동일)
  const prod = PRODUCTS.find(p=>p.name===o.product && norm(p.color)===norm(o.color));
  const newCost = (newType==='직거래' && prod.default_cost_pickup) ? prod.default_cost_pickup : (prod.default_cost||0);
  if(newCost>0) out.cost_price = newCost;
  // rep_price
  if(isAdminOrder && o.amount && o.qty){
    out.rep_price = Math.round(o.amount/o.qty);
  } else if(fixed && !isAdminOrder){
    // ⭐ 수정안: 입력자 주문이면 user_prices에서 거래방식별 단가 재계산
    const up = USER_PRICES.find(u=>u.user_id===o.created_by && u.product_name===o.product && norm(u.color)===norm(o.color));
    if(up) out.rep_price = (newType==='직거래' && up.rep_price_pickup!=null) ? up.rep_price_pickup : up.rep_price;
  }
  // buggy 경로: 입력자 주문 rep_price 그대로 둠
  return out;
}

console.log('═══ 다중 판매자 가격·정산 백테스트 ═══\n');

// S1: 서진 택배 1개, 손님 36000
console.log('── S1: 서진 택배 1개 (손님 36,000) ──');
const s1 = snapshotPrices({ created_by:'서진', product:'핸드카트', color:'블랙', type:'택배', qty:1, amount:36000 });
eq('S1 원가(택배)', s1.cost_price, 28000);
eq('S1 정산단가(택배)', s1.rep_price, 31000);
{ const L = sellerLedger([s1]); eq('S1 받은총액', L.received, 36000); eq('S1 정산할금액', L.settleUnsettled, 31000); eq('S1 내마진', L.margin, 5000); }

// S2: 서진 직거래 1개, 손님 33000
console.log('\n── S2: 서진 직거래 1개 (손님 33,000) ──');
const s2 = snapshotPrices({ created_by:'서진', product:'핸드카트', color:'블랙', type:'직거래', qty:1, amount:33000 });
eq('S2 원가(직거래)', s2.cost_price, 26000);
eq('S2 정산단가(직거래)', s2.rep_price, 29000);
{ const L = sellerLedger([s2]); eq('S2 내마진', L.margin, 4000); }

// S3: 미정 직거래 2개 (직거래 단가 미설정 → 택배가 32000 적용), 손님 64000
console.log('\n── S3: 미정 직거래 2개 (직거래 단가 미설정→32,000) ──');
const s3 = snapshotPrices({ created_by:'미정', product:'핸드카트', color:'블랙', type:'직거래', qty:2, amount:64000 });
eq('S3 원가(직거래)', s3.cost_price, 26000);
eq('S3 정산단가(직거래 미설정→택배가)', s3.rep_price, 32000);
{ const L = sellerLedger([s3]); eq('S3 정산할금액(32000×2)', L.settleUnsettled, 64000); eq('S3 내마진', L.margin, 0); }

// S4: 신입(단가미설정) 택배 1개 → 기본판매가, 이후 관리자가 31000 지정 → 소급정정
console.log('\n── S4: 신입 단가미설정 → 기본가, 이후 31,000 지정 소급정정 ──');
let s4 = snapshotPrices({ id:1, created_by:'신입', product:'핸드카트', color:'블랙', type:'택배', qty:1, amount:36000 });
eq('S4 정산단가(미설정→기본판매가)', s4.rep_price, 36000);
eq('S4 마진(처음)', sellerLedger([s4]).margin, 0);
// 관리자가 신입 단가 31000 추가 → maybeRecalcUserOrders → computeRecalc 재계산
USER_PRICES.push({ user_id:'신입', product_name:'핸드카트', color:'블랙', rep_price:31000, rep_price_pickup:null });
s4 = snapshotPrices({ id:1, created_by:'신입', product:'핸드카트', color:'블랙', type:'택배', qty:1, amount:36000 }); // 재계산 시뮬
eq('S4 정산단가(31000 지정 후 정정)', s4.rep_price, 31000);
eq('S4 마진(정정 후)', sellerLedger([s4]).margin, 5000);

// S5: 관리자 본인 주문 2개, 손님 총 72000 (네고 반영 amount/qty)
console.log('\n── S5: 관리자 본인 택배 2개 (손님 총 72,000) ──');
const ADMIN_IDS = new Set(['admin']);
const s5 = snapshotPrices({ created_by:'admin', product:'핸드카트', color:'블랙', type:'택배', qty:2, amount:72000 });
eq('S5 정산단가(amount/qty)', s5.rep_price, 36000);
eq('S5 원가', s5.cost_price, 28000);
eq('S5 카드마진(72000-56000)', cardMargin(s5, ADMIN_IDS), 16000);

// S6: 거래방식 변경 버그 — 서진 택배(31000) → 직거래로 수정
console.log('\n── S6: 거래방식 변경 (서진 택배31000 → 직거래) ──');
const buggy = saveEditTypeChange(s1, '직거래', { fixed:false });
eq('S6 [버그재현] 변경후 정산단가가 안 바뀜', buggy.rep_price, 31000);   // 잘못: 29000이어야
const fixedR = saveEditTypeChange(s1, '직거래', { fixed:true });
eq('S6 [수정안] 직거래 단가로 재계산', fixedR.rep_price, 29000);          // 올바름
eq('S6 [수정안] 원가도 직거래로', fixedR.cost_price, 26000);

// S7: 정산 일관성 — 서진 S1+S2 미정산, 관리자 집계 == 판매자 표시, 정산 후 마진 불변
console.log('\n── S7: 정산 일관성 (서진 S1+S2) ──');
let book = [ {...s1, id:'a'}, {...s2, id:'b'} ];
eq('S7 판매자 정산할금액', sellerLedger(book).settleUnsettled, 60000);
eq('S7 관리자 집계 == 판매자', adminSettle(book,'서진'), 60000);
eq('S7 정산전 마진', sellerLedger(book).margin, 9000);
book = book.map(o=>({ ...o, settled:true }));  // 관리자 정산완료 클릭
eq('S7 정산후 정산할금액 0', sellerLedger(book).settleUnsettled, 0);
eq('S7 정산후 마진 불변(9000)', sellerLedger(book).margin, 9000);
eq('S7 정산후 관리자 집계 0', adminSettle(book,'서진'), 0);

// S8: 판매자 간 장부 격리 — 서진/미정 주문이 섞여도 각자 본인 것만 집계
console.log('\n── S8: 두 판매자 장부 격리 ──');
const allOrders = [
  {...snapshotPrices({created_by:'서진',product:'핸드카트',color:'블랙',type:'택배',qty:1,amount:36000}), id:'x1'},
  {...snapshotPrices({created_by:'미정',product:'핸드카트',color:'블랙',type:'직거래',qty:2,amount:64000}), id:'x2'},
];
// loadOrders 필터 재현: 입력자는 created_by===본인만 로드
const seojinView = allOrders.filter(o=>o.created_by==='서진');
const mijeongView = allOrders.filter(o=>o.created_by==='미정');
eq('S8 서진은 본인 1건만', seojinView.length, 1);
eq('S8 미정은 본인 1건만', mijeongView.length, 1);
eq('S8 서진 정산할금액', adminSettle(allOrders,'서진'), 31000);
eq('S8 미정 정산할금액', adminSettle(allOrders,'미정'), 64000);
eq('S8 서진 마진', sellerLedger(seojinView).margin, 5000);

// S9: 관리자 본인 주문 할인/환불 정정 — amount 낮추면 rep=amount/qty 재계산, 마진 하락
console.log('\n── S9: 관리자 주문 할인 정정 (72000→66000, 2개) ──');
let admOrder = snapshotPrices({created_by:'admin',product:'핸드카트',color:'블랙',type:'택배',qty:2,amount:72000});
eq('S9 정정전 카드마진', cardMargin(admOrder, ADMIN_IDS), 16000);  // 72000-56000
// saveEdit: 관리자 본인 주문 amount/qty 변경 → rep_price=amount/qty
admOrder = { ...admOrder, amount:66000, rep_price:Math.round(66000/2) };
eq('S9 정정후 rep(개당)', admOrder.rep_price, 33000);
eq('S9 정정후 카드마진(66000-56000)', cardMargin(admOrder, ADMIN_IDS), 10000);

// S10: 입력자 수량 변경 → 정산이 개당단가×수량으로 스케일
console.log('\n── S10: 입력자 수량 1→2 변경 정산 스케일 ──');
const before = {...snapshotPrices({created_by:'서진',product:'핸드카트',color:'블랙',type:'택배',qty:1,amount:36000}), id:'q'};
eq('S10 1개 정산', sellerLedger([before]).settleUnsettled, 31000);
// 수량 2로 수정(트리거 미발화 — rep_price 개당 31000 유지), 금액도 2개분으로 갱신
const after = { ...before, qty:2, amount:72000 };
eq('S10 2개 정산(31000×2)', sellerLedger([after]).settleUnsettled, 62000);
eq('S10 2개 마진(72000-62000)', sellerLedger([after]).margin, 10000);

console.log(`\n═══ 결과: ${PASS} PASS / ${FAIL} FAIL ═══`);
process.exit(FAIL ? 1 : 0);
