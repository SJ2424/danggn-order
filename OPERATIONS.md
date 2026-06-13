# 📦 당근 발주 관리 시스템 — 완전한 운영 가이드 & 백업

> 이 단일 문서에 시스템 전체 구조, 운영 방법, 트러블슈팅, 모든 변경 이력,
> AI/개발자 인계용 컨텍스트가 다 담겨 있습니다.
> **마지막 업데이트**: 2026-06-13 · **v2.5.0** (버전번호 체계 §19 + 입력폼 모바일 정렬 + 다중판매자 점검 + RLS 가이드 §18)

---

## 0. 한 줄 요약

당근마켓 도매(선반랙·핸드카트 등)를 자동으로 발주·송장수집·정산하는 PWA.
**Vercel** (앱) + **Supabase** (DB·인증) + **GitHub Actions** (자동 봇).

---

## 1. 🌐 서비스 위치 (가장 중요 — 비번은 별도 보관!)

| 서비스 | URL | 역할 |
|---|---|---|
| **앱** (일상 사용) | https://danggn-order.vercel.app | PWA, 폰에 홈화면 추가 가능 |
| **Supabase** (데이터) | https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy | DB, 사용자, 트리거 |
| **GitHub** (코드+봇) | https://github.com/SJ2424/danggn-order | 모든 소스 + 자동 스케줄 |
| **Vercel** (호스팅) | https://vercel.com/dashboard | 자동 배포 |
| **OMS** (선반랙) | https://dooldool6611.com | 봇이 자동 로그인·등록 |
| **카트사이트** | GAS URL (코드에 하드코딩) | 봇이 자동 등록 |

**Supabase 프로젝트 ID**: `zmvllgztbqymwwfeprxy`
**GitHub 저장소**: `SJ2424/danggn-order`

⚠️ **위 5개 비밀번호는 비밀번호 매니저에 별도 보관 필수**. 특히 Supabase 잃으면 데이터 복구 불가.

---

## 2. ⏰ 자동 실행 스케줄 (실제 워크플로우 cron과 일치 — 2026-05-29 검증)

모두 **KST 기준 (UTC+9)**. 발주/송장/푸시는 **평일만**, 백업·72H 알림은 매일.

| 시간 (KST) | 봇 (워크플로우) | 무엇 |
|---|---|---|
| **08:01** | 🤖 선반랙 + 🛒 카트 발주 (1차) | 새벽·아침 모인 거 (화면엔 08:00 표시) |
| **11:50** | 🤖 선반랙 + 🛒 카트 발주 (2차, 오전 최종) | 12시 결제 대비 — ⚠️ 이후 주문은 다음날 08:01까지 자동등록 안 됨 |
| **12:08 / 12:33 / 12:48** | 💳 선반랙 결제 확인 (fetch-tracking) | OMS 입금완료 상태 읽어 자동 처리 (13시 마감 전) |
| **12:10 / 12:35 / 12:50** | 📲 푸시 알림 (send-push) | 발주완료·미결제 상기 |
| **14:00 / 16:00** | 🚚 선반랙(OMS) 송장 수집 (fetch-tracking) | 택배사 등록분 긁어옴 |
| **16:00 / 17:00** | 🚚 카트사이트 송장 수집 (fetch-cart-tracking) | 카트는 오후 3시+ 나옴 → 더 늦음 |
| 매일 **10:00** | 🚨 72H 미입금 알림 (check-overdue) | 입력자에게 푸시 |
| 매월 1일경 **02:00 KST** | 💾 DB 백업 (backup-monthly) | bot/backups/YYYY-MM.csv |

ℹ️ GitHub Actions cron은 UTC 기준이라 yml 주석에 KST 환산이 적혀있음. cron은 트래픽에 따라 수 분~수십 분 지연될 수 있음.
⚠️ **송장은 보통 발송 익일~익익일에 택배사가 등록** → 당일 오후 일찍(특히 14:00 1차 전)엔 아직 안 잡히는 게 정상. 선반랙은 14:00/16:00, 카트는 16:00/17:00 이후를 기준으로 보고, 며칠째 안 들어오면 그때 §8로 점검.

---

## 3. 🛠 기술 스택 & 파일 구조

```
[사용자 폰/PC] ──HTTPS─→ [Vercel: index.html]
                                ↕
                        [Supabase Postgres + Auth]
                                ↑
                        [GitHub Actions: bot/*.js (Playwright)]
                                ↓
                   [OMS] / [GAS 카트사이트]
```

### 파일 구조

```
danggn-order/
├── index.html                ← 앱 본체 (UI + 모든 JS, ~3000줄)
├── manifest.json             ← PWA 메타데이터
├── sw.js                     ← 푸시 알림 Service Worker
├── package.json              ← Vercel API용 의존성
├── OPERATIONS.md             ← ★ 이 문서
├── api/
│   └── run-bot.js            ← Vercel serverless (선택, 봇 트리거)
├── bot/
│   ├── package.json
│   ├── register-orders.js    ← 선반랙 OMS 자동 등록
│   ├── register-cart.js      ← 카트사이트 자동 등록
│   ├── fetch-tracking.js     ← 선반랙 송장 수집
│   ├── fetch-cart-tracking.js ← 카트 송장 수집
│   ├── send-push.js          ← 12:35 마감 임박 푸시
│   ├── check-overdue.js      ← 72시간 미입금 알림
│   └── backup-orders.js      ← 월별 DB→CSV 백업
└── .github/workflows/
    ├── register-orders.yml
    ├── register-cart.yml
    ├── fetch-tracking.yml
    ├── fetch-cart-tracking.yml
    ├── send-push.yml
    ├── check-overdue.yml
    └── backup-monthly.yml
```

---

## 4. 💾 DB 스키마 + SQL 마이그레이션

### 핵심 테이블

```
profiles
├── id (UUID)
├── email
├── display_name
└── role ('admin' | 'input' | 'pending')

orders
├── id (bigserial)
├── date (YYYY-MM-DD)
├── name, tel, addr
├── product, color, qty
├── type ('택배' | '직거래')
├── amount (실제 받은 총액)
├── cost_price (트리거가 자동)
├── rep_price (트리거가 자동, amount/qty)
├── status ('접수' | '발주완료' | '발송완료')
│        ※ '발주대기'는 더 이상 안 씀 (백워드 호환만)
├── paid, paid_by
├── tracking, shipped_at
├── phone (휴대폰별칭), nick (당근닉네임)
├── memo (자유 메모, 검색 가능)
├── bot_note (봇 실패 메시지)
├── created_by, created_at, settled

products
├── name, color
├── default_cost (택배 원가)
├── default_cost_pickup (직거래 원가)
└── default_rep_price (기본 판매가)

user_prices
├── user_id, product_name, color
├── rep_price (입력자별 택배 정산단가)
└── rep_price_pickup (입력자별 직거래 정산단가 — 비우면 rep_price 사용)

stock_receipts (입고 기록)
├── date, product, color, qty
├── purchase_unit, logistics_total, unit_cost
└── note

push_subscriptions
├── user_id
└── endpoint, p256dh, auth
```

### SQL 한 번에 — 새 환경 셋업 또는 누락 의심시

[Supabase SQL Editor](https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy/sql/new)에 통째로 붙여넣기 (idempotent — 여러 번 실행해도 안전):

```sql
-- 1) 컬럼 확장
alter table public.products add column if not exists default_cost_pickup int;
alter table public.orders   add column if not exists bot_note text;
alter table public.orders   add column if not exists memo text;
alter table public.orders   add column if not exists shipped_at timestamptz;
alter table public.orders   add column if not exists settled boolean default false;
-- ⭐ OMS/카트 결제 확인 플래그 — 이게 없으면 "💳 결제 완료 체크"가 영원히 '결제 대기'로 떠 있음
alter table public.orders   add column if not exists oms_paid boolean not null default false;
-- ⭐ 중복발주 방지(멱등성) — 봇이 외부 등록 직전 처리중 표식. 없으면 "등록 성공→마킹 실패" 시 다음 크론이 재발주
alter table public.orders   add column if not exists bot_claimed_at timestamptz;
-- ⭐ 사람별 정산방식 — settle_basis: 'rep'(기본판매가, 기본값) | 'cost'(원가+마진). settle_margin: 원가정산 시 내 마진(원)
alter table public.profiles add column if not exists settle_basis text not null default 'rep';
alter table public.profiles add column if not exists settle_margin int not null default 0;
-- ⭐ 주문자별 직거래 정산단가 — 비우면(null) rep_price(택배가) 사용. 같은 사람도 직거래/택배 단가 다르게.
alter table public.user_prices add column if not exists rep_price_pickup int;

-- 2) 기본 상품
insert into public.products (name, color, default_cost, default_rep_price)
values ('핸드카트','블랙',28000,36000)
on conflict (name, color) do nothing;

-- 3) 입고 기록 테이블
create table if not exists public.stock_receipts (
  id bigserial primary key,
  date date not null,
  product text not null,
  color text,
  qty int not null check (qty > 0),
  purchase_unit int not null check (purchase_unit >= 0),
  logistics_total int not null default 0 check (logistics_total >= 0),
  unit_cost int not null check (unit_cost >= 0),
  note text,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id) default auth.uid()
);
alter table public.stock_receipts enable row level security;
drop policy if exists "admin manages stock_receipts" on public.stock_receipts;
create policy "admin manages stock_receipts" on public.stock_receipts for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role='admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role='admin'));

-- 4) 입고 → 카탈로그 default_cost 자동 갱신
create or replace function public.apply_receipt_to_product()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.products set default_cost = NEW.unit_cost
  where name = NEW.product and ((color is null and NEW.color is null) or color = NEW.color);
  return NEW;
end; $$;
drop trigger if exists trg_apply_receipt on public.stock_receipts;
create trigger trg_apply_receipt after insert on public.stock_receipts
for each row execute function public.apply_receipt_to_product();

-- 5) ⭐ 가격 자동 스냅샷 트리거 (가장 중요)
create or replace function public.snapshot_prices()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cost int; v_rep int; v_role text; v_basis text; v_margin int;
begin
  -- cost_price: 거래 type 분기
  if NEW.cost_price is null then
    if NEW.type = '직거래' then
      select coalesce(default_cost_pickup, default_cost) into v_cost
      from public.products where name = NEW.product
        and ((color is null and NEW.color is null) or color = NEW.color) limit 1;
    else
      select default_cost into v_cost from public.products
      where name = NEW.product
        and ((color is null and NEW.color is null) or color = NEW.color) limit 1;
    end if;
    NEW.cost_price := coalesce(v_cost, 0);
  end if;
  -- rep_price (개당): 특별단가(제품예외) → 관리자 amount/qty → 사람별 정산방식(원가+마진) → 기본판매가
  if NEW.rep_price is null then
    -- 1) 사용자별 특별단가 (제품 예외 — 최우선); 직거래면 rep_price_pickup 우선(없으면 rep_price)
    select case when NEW.type = '직거래' then coalesce(rep_price_pickup, rep_price)
                else rep_price end
      into v_rep from public.user_prices
    where user_id = NEW.created_by and product_name = NEW.product
      and ((color is null and NEW.color is null) or color = NEW.color) limit 1;
    if v_rep is null then
      -- 사람별 역할 + 정산방식 조회 (settle_basis: 'rep'=판매가, 'cost'=원가+마진)
      select role, coalesce(settle_basis,'rep'), coalesce(settle_margin,0)
        into v_role, v_basis, v_margin
      from public.profiles where id = NEW.created_by;
      -- 2) 관리자 직접 입력: 받은 금액 ÷ 수량 (네고·할인 자동 반영)
      if v_role = 'admin' and NEW.amount is not null and coalesce(NEW.qty,1) > 0 then
        v_rep := (NEW.amount::float / coalesce(NEW.qty,1))::int;
      -- 3) ⭐ 원가 정산: 그 시점 원가 + 마진 (원가는 위에서 이미 스냅샷됨 → '그 시점' 고정)
      elsif v_basis = 'cost' then
        v_rep := coalesce(NEW.cost_price, 0) + coalesce(v_margin, 0);
      -- 4) 기본 판매가
      else
        select default_rep_price into v_rep from public.products
        where name = NEW.product
          and ((color is null and NEW.color is null) or color = NEW.color) limit 1;
      end if;
    end if;
    NEW.rep_price := coalesce(v_rep, NEW.amount, 0);
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_snapshot_prices on public.orders;
create trigger trg_snapshot_prices before insert on public.orders
for each row execute function public.snapshot_prices();
```

### 잘못된 마진 일괄 정정

```sql
-- 관리자 본인 입력 주문의 개당 가격 정정 (amount/qty)
UPDATE public.orders
SET rep_price = (amount::float / NULLIF(qty, 0))::int
WHERE created_by IN (SELECT id FROM public.profiles WHERE role='admin')
  AND amount IS NOT NULL AND amount > 0 AND qty > 0;
```

또는 앱: **🎛 관리 모드 → 🔧 설정·도구 → 🔄 과거 주문 단가 재계산**

---

## 5. 🔐 비밀 키 위치

| 키 | 어디 | 무엇용 |
|---|---|---|
| `OMS_USERNAME`, `OMS_PASSWORD` | GitHub Secrets | dooldool6611 로그인 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | GitHub Secrets | 봇이 DB 접근 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | GitHub Secrets | Web Push |
| `GITHUB_TOKEN` (선택) | localStorage 또는 Vercel | 봇 1클릭 즉시 실행 |

위치: https://github.com/SJ2424/danggn-order/settings/secrets/actions

---

## 6. 👤 사용자 역할

| 역할 | 권한 |
|---|---|
| `admin` | 모든 주문, 카탈로그, 봇 |
| `input` | 본인 주문만 |
| `pending` | 승인 대기 |
| `banned` | 차단 |

### 새 입력자 추가
1. 회원가입 → role='pending'
2. 관리자가 [승인대기] 클릭 → 승인 → role='input'

### 관리자 권한 이전
```sql
update profiles set role='admin' where display_name='새관리자이름';
update profiles set role='input' where display_name='기존관리자이름';
```

### 비밀번호 재설정
[Auth Users](https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy/auth/users) → 클릭 → Reset password

---

## 7. 📋 일상 운영 워크플로우

```
1. 손님 카톡
   ↓
2. 앱 → ✏️ 주문 입력
   - 이름·연락처 (전화 키패드)
   - 🔍 카카오 주소 검색
   - 상품(dropdown)·색상·수량
   - 거래방식·받은 금액
   - [+ 주문 목록에 추가]
   ↓
3. 자동 (08:00 / 12:00 / 12:30 / 12:51)
   봇이 OMS·카트사이트 자동 등록 → 발주완료
   ↓
4. 본인이 OMS 가서 결제·일괄주문 (12:55 마감)
   ↓ 16:02 / 17:02
5. 자동 송장 수집 → 발송완료 + 송장 채워짐
   ↓
6. 손님 입금 → 미입금 알약 클릭 → 완료 ✅
```

**메모 활용**: 카드의 📝 칸에 자유 입력 (단골/사은품/할인 등). 검색 가능.

---

## 8. 🚨 트러블슈팅

### 봇 실행 확인
- https://github.com/SJ2424/danggn-order/actions
- 실패면 빨간 X 클릭 → 로그·스크린샷 확인

### GitHub 장애 발생시
- https://www.githubstatus.com — major/minor outage이면 스케줄 지연·skip 가능
- 대응: 본인이 OMS·카트사이트 가서 수동 확인 (또는 GH 복구 기다림)

### 주문 OMS 등록 안 됨
- 카드의 빨간 **🤖 봇 메시지** 확인
- 주소 매칭 실패 → [✏️ 수정] → 🔍 주소 재검색 → 저장 → 다음 봇

### 송장 안 채워짐
- 손님 발송 익일~익익일이 보통
- 16:02/17:02 사이클 후에도 안 들어오면 카드 [✏️ 수정]에서 수동 입력

### 마진 이상
1. 카탈로그 [⚙️ 상품 가격] 확인
2. [🔄 과거 주문 단가 재계산]
3. 위 SQL 마이그레이션 #5 (트리거) 재실행

### 푸시 알림 안 옴
- iPhone: Safari로 앱 열고 홈화면 추가 → 그 아이콘으로 열기
- 알림 권한: 폰 설정 → 알림 → 「당근 발주 관리」 → 허용
- 🔧 설정·도구 → 🔔 [이 기기 알림 켜기] 재클릭

### 앱 흰화면
- 강제 새로고침 (Ctrl+Shift+R / iOS Safari 주소창 길게 → 새로고침)
- Vercel Deployments → 이전 배포 [Promote to Production]

---

## 9. 💾 백업 정책

### 자동 (이미 작동)
- Supabase: 매일 DB (7일 보관)
- GitHub: 커밋 영구
- bot/backup-orders.js: 매월 1일 02:00 KST → bot/backups/YYYY-MM.csv 커밋

### 수동 (월 1회 권장)
1. 앱 → 📒 장부 → [📥 거래내역 CSV 다운로드]
2. 파일명: `당근장부_전체_YYYY-MM.csv`
3. PC + 클라우드(Google Drive 등) 둘 다 저장

### 절대 잃으면 안 되는 것
- Supabase 로그인 (= 데이터 보관)
- GitHub 로그인 (= 코드·자동봇)
- Vercel 로그인 (= 호스팅, GitHub에서 재연결 가능)

---

## 10. 📝 최근 변경 이력 (2026-05-25 ~ 26)

이 시스템에 큰 영향을 준 결정과 변경:

### 1차 — 기본 구축
- 앱 + DB + 봇 셋업
- 카탈로그 + 입고기록 + 사용자별 단가
- 마진 자동 계산 (rep_price = amount/qty for admin)

### 2차 — UI 최적화
- 카드 디자인 통합 (마진 inline + 메모 inline)
- 주문 입력 폼 효율화 (채팅 복붙 접힘 + dropdown)
- 거래내역 카드 스타일 (모바일 가독성)
- 장부 요약 풍부화 (상품별/거래별/입금별 breakdown)

### 3차 — 봇·자동화
- 카트 송장 수집 봇 추가
- 봇 버튼 silent (popup 제거, GitHub 토큰 깊은 곳으로)
- 스케줄 단순화 (선반랙·카트 동일: 08:00/12:00/12:30/12:51)
- 송장 2회로 단순화 (16:02, 17:02)

### 4차 — 종합 점검 픽스
- **CRITICAL**: register-orders.js `.catch is not a function` (Supabase는 thenable, .catch 없음) → try/catch
- **CRITICAL**: 인라인 편집 (paid_by, memo) silent fail → await + try/catch
- **CRITICAL**: 카트 봇 markRegistered 에러 미체크 → throw + concurrency 그룹 추가
- **HIGH**: checkDeadline UTC vs KST 불일치 (알람 새벽 반복) → KST 통일
- **HIGH**: renderTodaySummary 폰 timezone 의존 → KST 강제
- **HIGH**: 푸시 메시지 발주대기 참조 (이미 죽은 상태) → 발주완료-미입금으로 정정

### 6차 — 주문자별 직거래/택배 단가 + 단가 미설정 정정 + 관리자 메뉴 정리 (2026-06-13)
- **주문자별 단가를 거래방식(택배/직거래)별로 분리**
  - `user_prices.rep_price_pickup` 컬럼 추가 (비우면 rep_price=택배가 사용)
  - 트리거 `snapshot_prices`: 직거래 주문이면 `coalesce(rep_price_pickup, rep_price)` 적용
  - ⚠️ **DB 마이그레이션 필요**: §4 SQL의 `alter table ... add ... rep_price_pickup` + 트리거 재실행
- **가입 먼저 → 단가 늦게 정한 경우 소급 정정**
  - 주문자 단가 추가/수정 시, 그 사람의 *미정산* 기존 주문을 새 단가로 정정할지 물어봄 (`maybeRecalcUserOrders`)
  - 👥 주문자별 단가 카드 상단에 "단가 미설정 주문자" 경고 (주문은 있는데 단가 안 정한 사람 안내)
- **관리자 모드 UI 정리 (사용자 관점 미니멀)**
  - 핵심 반복 작업인 `👥 주문자별 단가`·`📦 입고 기록`을 깊은 설정 메뉴에서 **최상위 카드로 승격**
  - 전문용어 라벨 순화 ("외부 cron 백업" → "봇 자동실행 이중 안전장치 (고급)")

### 7차 — 다중 판매자 종합 점검 + 백테스트 (2026-06-13)
- **거래방식변경 정산버그 FIX**: 입력자 주문 택배↔직거래 수정시 정산단가 미갱신 → `saveEdit` 재계산
- **정산금 일치**: 입력자 "정산할 금액" = 전체 미정산(누적)으로 → 관리자 정산카드와 항상 동일
- **백테스트 추가**: `sim-pricing.mjs` (7시나리오 28단언, 트리거+장부+정산 재현 검증)
- **보안 가이드**: §18 — RLS 확인·강화(orders/profiles/user_prices), 재귀방지 헬퍼 + 역할승격 차단 트리거
- 봇 다중판매자 정합성 재확인: 모든 판매자 접수분 발주(직거래 제외), 72H 미입금 푸시는 입력자 본인만

### 5차 — 새 입력자·단가 시나리오 전문가 점검
- **CRITICAL**: 직거래 주문이 봇에 의해 OMS/카트사이트에 자동 등록되던 문제
  - 직거래는 손님 직접 만남이라 등록되면 안 됨
  - register-orders.js + register-cart.js: `type !== '직거래'` 필터 추가
  - 스킵 카운트 로깅
- **HIGH**: 관리자가 주문 amount/qty 수정해도 rep_price 안 바뀜
  - snapshot_prices 트리거는 INSERT만 발화 (UPDATE 안 발화)
  - saveEdit에서 admin 본인 주문이면 rep_price 수동 재계산 (amount/qty)
  - 거래 type 변경시 cost_price도 재계산
- **MEDIUM**: 입력자 본인 정산 통계 표시
  - 옛: 받은 총 금액만
  - 새: '관리자에게 정산할 금액' + '내 마진 (받은 - 정산할)' 추가

---

## 11. 🎯 시스템 디자인 결정 (왜 이렇게?)

- **Supabase + Vercel**: 무료 tier 충분, 한국 인프라, 관리 쉬움
- **GitHub Actions 봇**: 별도 서버 불필요, 무료, 자동 실행
- **Playwright**: OMS·카트사이트 API 없음 → 헤드리스 브라우저
- **rep_price = amount/qty (관리자)**: 네고·할인 자동 반영
- **접수 → 발주완료 직진** (옛 발주대기 단계 제거): 사용자가 까먹어 송장 안 잡힘 → 단순화
- **카카오 우편번호 embed**: PWA에서 팝업 차단 회피 + 검증
- **토큰 옵션은 깊이**: 99%는 자동으로 충분, 1%만 즉시 실행

---

## 12. 🤖 새 채팅·AI에게 인계할 때

이 문서를 첨부하면 다음이 즉시 파악됨:
- 기술 스택 (§3)
- 자동 스케줄 (§2)
- DB 스키마 (§4)
- 사용자 역할 (§6)
- 워크플로우 (§7)
- 트러블슈팅 (§8)
- 최근 변경 (§10)
- 디자인 결정 (§11)

### 인계 메시지 예시
```
당근 발주 관리 시스템 운영 중입니다. 첨부한 OPERATIONS.md를 컨텍스트로
[해결하려는 문제] 도와주세요.

저장소: https://github.com/SJ2424/danggn-order
```

---

## 13. 🛠 자주 쓰는 명령 (개발 시)

```bash
# 봇 수동 실행 (gh CLI 있을 때)
gh workflow run register-orders.yml -f dry_run=false
gh workflow run register-cart.yml -f dry_run=false
gh workflow run fetch-tracking.yml -f dry_run=false
gh workflow run fetch-cart-tracking.yml -f dry_run=false

# 봇 로그 확인
gh run list --workflow=register-orders.yml --limit 5
gh run view <ID> --log

# 최근 실행 모두 확인
gh run list --limit 20
```

---

## 14. 💡 알아두면 좋은 GitHub Actions 특성

- `cron`은 GitHub Actions 트래픽에 따라 **수 분 ~ 수 시간 지연** 가능
- 정시 (:00, :30) 트래픽이 가장 몰림 → :02, :32 같은 offset 권장
- GitHub 자체 장애 (githubstatus.com 확인) 시 schedule 전부 skip 가능
- 개인 무료 tier: 월 2000분 (이 시스템은 월 ~500분 사용 추정 → 여유)

---

## 15. 🔄 어디서든 작업 재개하는 법

다른 PC·노트북·휴대폰에서 다시 시작하려면:

### A) 본인 작업 (운영)
1. **Vercel 앱 URL 접속**: https://danggn-order.vercel.app
2. 로그인 (이름·비밀번호)
3. 끝 — 데이터 다 동기화돼있음

### B) 개발 (코드 수정 등)
1. **저장소 클론**: `git clone https://github.com/SJ2424/danggn-order.git`
2. 이 OPERATIONS.md 읽기 (모든 컨텍스트 여기)
3. 필요한 변경 → commit → push → Vercel 자동 재배포

### C) AI 도구로 도움 받기
1. 새 채팅 시작
2. 이 OPERATIONS.md 통째로 첨부 또는 복붙
3. "이 시스템 운영 중. [질문/요청]"

---

## 16. 📞 핵심 contact

- 데이터·서비스 장애: 본인이 Supabase/Vercel/GitHub 대시보드 확인
- 코드 변경 필요: GitHub PR 또는 AI에게 이 문서 + 요구사항
- 비밀번호 잊었을 때: 각 서비스 비밀번호 재설정 (이메일 인증)

---

**END OF DOCUMENT**

| 항목 | 상태 |
|---|---|
| 시스템 운영 상태 | ✅ 정상 |
| 자동 봇 안정성 | ✅ 종합 점검 완료 |
| 인라인 편집 에러 핸들링 | ✅ 픽스 완료 |
| 카트 봇 중복 등록 방지 | ✅ concurrency + error check |
| KST/UTC 시간 일관성 | ✅ 통일 |
| 푸시 메시지 정확성 | ✅ 발주대기 죽은 참조 제거 |
| 백업·복구 가능성 | ✅ 자동 + 수동 |

**마지막 commit**: `f277722` 전문가 점검 픽스 — 직거래 봇 스킵 + 수정시 마진 재계산 + 입력자 정산 표시

---

## 17. 🧑‍💼 새 입력자 시나리오 — 전체 작동 확인 ✅

새 입력자(예: 박서진)가 추가되어 본인과 다른 단가(예: 31,000원)로 운영할 수 있나? **YES**.

### 흐름
```
1. 박서진이 앱 → 회원가입 (이름, 비밀번호)
   role='pending' 상태로 저장

2. 관리자 화면 우측 상단 [승인대기 1] 클릭 → [승인] →
   role='input' 자동 전환 (realtime — 박서진 화면 자동 새로고침)

3. 관리자가 박서진 단가 설정:
   🎛 관리 모드 → 👥 주문자별 단가 (최상위 카드)
   주문자: 박서진 / 상품: 선반랙·화이트 / 택배 단가: 31,000 / 직거래 단가: 29,000(선택) → 추가
   · 직거래 칸 비우면 택배 단가가 직거래에도 적용
   · 단가 정하면 "기존 주문도 정정?" 물어봄 (가입 먼저 + 단가 늦게 정한 경우 소급 정정)

4. 박서진 로그인 → 주문 입력
   - 손님한테 받은 amount: 36,000
   - 트리거 자동: rep_price = 31,000 (user_prices에서)
                cost_price = 28,000 (택배 원가)

5. 박서진 본인 장부에서:
   - 받은 총 금액: 36,000
   - 관리자에게 정산할 금액: 31,000  ← 새 표시
   - 내 마진: 5,000  ← 새 표시 (초록 박스)

6. 봇이 자동 발주 → 발주완료 → 송장

7. 손님 입금 → 박서진이 [미입금] 토글 → 입금완료

8. 박서진이 본인 계좌로 정산 받은 후 본인(관리자)한테 31,000 송금

9. 관리자가 🔧 설정·도구 (또는 미정산 카드) → [정산 완료] →
   박서진의 미정산 주문 전부 settled=true
```

### 시스템 보장사항 (확인됨)
- ✅ 입력자는 본인 주문만 조회·수정 (loadOrders 필터)
- ✅ 직거래는 봇이 자동 등록 안 함 (수동 처리)
- ✅ 사용자별 특별 단가 설정시 트리거가 자동 적용
- ✅ 미설정 입력자는 default_rep_price 적용
- ✅ 관리자 본인 직접 입력은 amount/qty 자동 (네고 반영)
- ✅ 입력자한테 정산할 금액·본인 마진 명확히 표시
- ✅ 입력자별 미정산 그룹화 + 일괄 정산 처리
- ✅ 72H 미입금 푸시는 입력자 본인에게만 (관리자 X)
- ✅ 관리자가 주문 수정시 마진 재계산
- ✅ 새 입력자 승인 즉시 realtime 화면 전환

---

## 18. 🔒 다중 판매자 보안 — RLS 확인 & 강화 (⚠️ 중요, 한 번만)

### 왜 중요한가
앱은 누구나 소스에서 볼 수 있는 **공개 anon 키**로 DB에 접근한다(Supabase 정상 구조).
실제 보안은 전적으로 DB의 **RLS(Row Level Security, 행 수준 보안)**가 책임진다.
앱 화면의 "입력자는 본인 주문만 보임"은 **자바스크립트 필터**일 뿐 —
RLS가 꺼져 있으면, 입력자가 브라우저 콘솔에서 직접 쿼리해
**다른 판매자의 손님 이름·전화·주소를 전부 보거나, 본인을 admin으로 승격**시킬 수 있다.

> 가족·지인처럼 신뢰하는 소수 판매자면 위험이 낮지만, 그래도 한 번 잠가두는 걸 권장.

### 1단계 — 현재 상태 확인 (읽기 전용, 안전)
[Supabase SQL Editor](https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy/sql/new)에 붙여넣고 실행:

```sql
-- 각 테이블 RLS 켜짐 여부 (rowsecurity=true 면 켜짐)
select tablename, rowsecurity from pg_tables
where schemaname='public' and tablename in ('orders','profiles','user_prices','stock_receipts')
order by tablename;
-- 현재 정책 목록
select tablename, policyname, cmd from pg_policies where schemaname='public' order by tablename;
```

`orders`·`profiles`·`user_prices`의 `rowsecurity`가 **false**면 → 아래 2단계로 잠근다.
(대시보드 Table Editor에서 테이블별 RLS on/off 뱃지로도 확인 가능)

### 2단계 — 강화 SQL (idempotent, 안전 패턴)
⚠️ **적용 직후 반드시 3단계 테스트**. 봇은 service_role 키라 RLS 무관(안 깨짐).
profiles 정책이 profiles를 직접 조회하면 **무한재귀** 에러가 나므로,
관리자 판정은 `security definer` 헬퍼 함수로 처리한다(핵심).

```sql
-- 0) 관리자 판정 헬퍼 (security definer → RLS 우회 → 재귀 방지)
create or replace function public.is_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- 1) orders — 관리자 전체 / 입력자 본인만
alter table public.orders enable row level security;
drop policy if exists "orders admin all" on public.orders;
create policy "orders admin all" on public.orders for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "orders own" on public.orders;
create policy "orders own" on public.orders for all to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- 2) user_prices — 관리자 관리 / 입력자 본인 단가 읽기만
alter table public.user_prices enable row level security;
drop policy if exists "user_prices admin all" on public.user_prices;
create policy "user_prices admin all" on public.user_prices for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "user_prices own read" on public.user_prices;
create policy "user_prices own read" on public.user_prices for select to authenticated
  using (user_id = auth.uid());

-- 3) profiles — 관리자 전체 / 본인 읽기·이름수정(역할승격은 트리거가 차단)
alter table public.profiles enable row level security;
drop policy if exists "profiles admin all" on public.profiles;
create policy "profiles admin all" on public.profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
drop policy if exists "profiles own read" on public.profiles;
create policy "profiles own read" on public.profiles for select to authenticated
  using (id = auth.uid());
drop policy if exists "profiles own update" on public.profiles;
create policy "profiles own update" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- ⭐ 본인이 자기 role을 못 바꾸게 (이름변경은 OK, admin 승격은 차단)
create or replace function public.prevent_role_self_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.role is distinct from OLD.role and not public.is_admin() then
    raise exception 'role change not allowed';
  end if;
  return NEW;
end; $$;
drop trigger if exists trg_prevent_role_self_change on public.profiles;
create trigger trg_prevent_role_self_change before update on public.profiles
  for each row execute function public.prevent_role_self_change();
```

### 3단계 — 적용 직후 테스트 (필수)
1. **관리자 본인**으로 앱 새로고침 → 모든 주문 보임 + 승인대기/정산 정상 → OK
2. **입력자 계정**으로 로그인 → 본인 주문만 보임 + 주문 추가/입금체크/이름변경 됨 → OK
3. 둘 다 정상이면 완료. **하나라도 안 되면 즉시 롤백**(아래) 후 알려주기.

### 롤백 (문제 생기면 한 줄씩)
```sql
alter table public.orders      disable row level security;
alter table public.user_prices disable row level security;
alter table public.profiles    disable row level security;
```

> 💡 비전문가가 단독 적용하다 관리자가 잠기면 곤란하니, **AI와 함께 1단계 결과를 보며 진행**하는 걸 권장.
> (1단계 출력만 붙여주면 현재 상태에 맞춰 최소 SQL만 안내 가능)

### 6차 보강 점검 — 거래방식 변경·정산 일치 (2026-06-13)
- **FIX**: 입력자 주문의 거래방식(택배↔직거래)을 *나중에 수정*하면 정산단가(rep_price)가
  옛 방식에 멈춰 있던 버그 → `saveEdit`에서 `user_prices` 기준 재계산 추가.
  입력자도 본인 단가를 로드(`loadUserPrices` 본인 필터)해 자기 수정에도 반영.
- **개선**: 입력자 "관리자에게 정산할 금액"을 기간(이번달)이 아닌 **전체 미정산**으로 —
  관리자 정산카드(누적)와 항상 같은 숫자가 나오도록.
- **백테스트**: `node sim-pricing.mjs` — 트리거 가격계산 + 장부/정산/마진을 재현해
  7개 시나리오 28개 단언 검증(택배/직거래/미설정 소급/관리자 네고/거래방식변경/정산일치).

---

## 19. 🔖 버전 기록 (Version History)

앱 우상단·설정에 표시되는 버전 = **애플식 `큰변화.기능.버그수정`** (예: `2.5.0`).

### 올리는 법 (업데이트 때)
`index.html`의 `const APP_VERSION = '2.5.0'` 한 줄만 바꾸면 헤더·설정에 자동 표시됨.
- 🐛 **버그 수정** → 끝자리 +1 (`2.5.0` → `2.5.1`)
- ✨ **새 기능** → 가운데 +1, 끝자리 0 (`2.5.1` → `2.6.0`)
- 🔁 **큰 개편** → 앞자리 +1 (`2.x` → `3.0.0`)

`APP_VERSION_DATE`(배포일)도 같이 갱신. 변경 내용은 아래 표에 한 줄 추가.

> 이렇게 하면 "지금 몇 버전?"으로 서로 확인 가능하고, "그 버그는 v2.5.0이었다"처럼 추적돼요.

### 기록

| 버전 | 날짜 | 내용 |
|---|---|---|
| **2.5.4** | 2026-06-13 | 버그픽스 — 관리자 장부 하단에 입력자 전용 블록(내 판매·정산할금액 0원)이 새어 보이던 것 수정(.ledger-stats가 .input-only를 덮어쓰던 CSS 특이도 문제 → deny-by-default). 가짜데이터 전체 렌더로 역산 검증(매출/원가/마진/정산 전부 일치) |
| **2.5.3** | 2026-06-13 | 주문관리 추가 미니멀화 — 자동발주 시간표+봇 수동버튼을 하나의 접이식 "🤖 봇" 칸으로 통합(평소 접힘), 버전·앱새로받기 줄을 맨 아래로(구분선) |
| **2.5.2** | 2026-06-13 | 주문관리 미니멀 정리 — 중복 카운트줄(#summary, 오늘요약·필터칩과 겹침+죽은 발주대기 표시) 제거, "최신 날짜순" 설명문 제거, 봇 수동버튼(선반랙/카트/송장)을 접이식으로(평소 자동·급할 때만) |
| **2.5.1** | 2026-06-13 | 주문관리 모바일 정렬 — 다음 자동실행 시간표 칩 세로 1열(라벨 왼쪽·시간 오른쪽), 봇 버튼(선반랙/카트/송장) 3등분 한 줄로 (2+1 줄바꿈 제거) |
| **2.5.0** | 2026-06-13 | 버전번호 체계 도입 · 입력폼 수량+거래방식 한 줄 정렬(모바일 외톨이칸 제거). 이날 함께: 다중판매자 종합점검, 거래방식 정산버그 픽스(#41), 역할 권한 기본차단(#42), 마진 이중차단·로그인 브랜딩(#43), 단가/카탈로그 표 모바일 정렬(#44) |
| (이전) | ~2026-06-12 | 비공식(서술형 라벨) — 주문자별 직거래/택배 단가 분리, 봇 자동화, 카탈로그·입고기록 등. 상세는 §10 변경 이력 참고 |

> 다음 업데이트부터는 배포할 때마다 위 표에 버전·날짜·한 줄 요약을 추가하세요.
