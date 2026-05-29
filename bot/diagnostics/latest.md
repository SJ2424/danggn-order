# 🩺 라이브 DB 자가진단 리포트
> 생성: **2026-05-29 23:49 KST** · 개인정보(이름·전화·주소) 미포함 — 집계/플래그만

## 1. 컬럼 존재 확인
- `orders.oms_paid`: ✅ 있음
- `orders.settled`: ✅ 있음
- `orders.shipped_at`: ✅ 있음
- `orders.bot_note`: ✅ 있음
- `orders.memo`: ✅ 있음
- `orders.cost_price`: ✅ 있음
- `orders.rep_price`: ✅ 있음
- `products.default_cost_pickup`: ✅ 있음
- `profiles.approved_at`: ✅ 있음

## 2. 주문 현황
- 총 주문: **71건**
- 상태별: 발송완료 70 · 발주완료 1
- 입금완료(paid): 64 · 송장있음: 48 · 직거래: 9 · 택배: 62
- OMS결제(oms_paid): 3

## 3. 이상 징후 (0이면 정상)
- 원가(cost_price) 미설정 — 트리거 누락 의심: **0건** ✅
- 납품가(rep_price) 미설정 — 트리거 누락 의심: **0건** ✅
- 발주완료인데 송장없이 3일+ (등록 누락/거짓성공 의심): **0건** ✅
- 봇 실패메시지(bot_note) 남은 주문: **0건** ✅
- 직거래인데 OMS결제 표시(모순): **0건** ✅
- 발송완료·미입금 3일+ (수금 추적 필요): **0건** ✅
- 옛 상태(발주대기) 잔존 — 정리 대상: **0건** ✅

## 4. 사용자 · 카탈로그
- 사용자 역할별: admin 1 · input 1
- 상품(products): 6개
- 사용자별 단가(user_prices): 0개
- 입고기록(stock_receipts): 0개
- 푸시구독(push_subscriptions): 6개

## 5. 종합
- ✅ 점검한 컬럼 모두 존재
