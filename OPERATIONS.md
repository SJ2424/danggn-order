# 📦 당근 발주 관리 시스템 — 운영 가이드 & 백업

> 이 문서는 시스템 전체 구조, 운영 방법, 문제 해결, AI/개발자에게 컨텍스트로
> 줄 수 있는 모든 정보를 담은 단일 백업 문서입니다.
> 마지막 업데이트: 2026-05-26

---

## 0. 한 줄 요약

당근마켓 도매(선반랙 + 핸드카트 등)을 자동으로 발주·송장수집·정산하는
PWA 앱. Vercel(앱) + Supabase(DB) + GitHub Actions(봇) 조합으로 운영.

---

## 1. 🌐 서비스 위치 & 로그인 (가장 중요 — 안전하게 보관!)

| 서비스 | URL | 역할 |
|---|---|---|
| **앱** (사용자가 매일 쓰는 곳) | https://danggn-order.vercel.app | PWA, 폰에 홈화면 추가 |
| **Supabase** (데이터·인증) | https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy | DB, 사용자, 트리거, 백업 |
| **GitHub** (코드) | https://github.com/SJ2424/danggn-order | 앱·봇 소스, 자동 실행 |
| **Vercel** (앱 호스팅) | https://vercel.com/dashboard | 자동 배포, 환경변수 |
| **OMS** (선반랙 도매처) | https://dooldool6611.com | 봇이 자동 로그인·등록 |
| **카트사이트** (핸드카트 도매처) | `https://script.google.com/macros/s/AKfycbyK1MU-BWQeiNwv1Sx5BP4pesUytBmYmCTDDXdna24hRB6YY5sB6M1l_2xfQmDMKdmw7w/exec` | GAS, 봇이 자동 등록 |

**Supabase 프로젝트 ID**: `zmvllgztbqymwwfeprxy`
**GitHub 저장소**: `SJ2424/danggn-order`

⚠️ **위 5개 서비스 비밀번호는 비밀번호 매니저(1Password/Bitwarden) 또는 보안 노트에 보관 필수.**
특히 Supabase 잃으면 데이터 복구 불가.

---

## 2. 🛠 기술 스택 & 아키텍처

```
[사용자 폰/PC] ←HTTPS→ [Vercel: index.html (정적 SPA)]
                              ↕
                       [Supabase Postgres + Auth]
                              ↑
                       [GitHub Actions cron: bot/*.js]
                              ↓
              [OMS dooldool6611] / [GAS 카트사이트]
```

- **프론트**: 순수 HTML/CSS/JS (index.html 단일 파일, ~3000 lines)
- **DB·인증**: Supabase (Postgres + Auth + RLS + Realtime)
- **봇**: Node.js + Playwright (헤드리스 크롬), GitHub Actions 평일 cron
- **푸시 알림**: Web Push (VAPID), Service Worker (sw.js)
- **PWA**: manifest.json (홈화면 추가 가능)

### 주요 파일

```
danggn-order/
├── index.html             ← 앱 본체 (모든 UI + JS)
├── manifest.json          ← PWA 메타데이터
├── sw.js                  ← 푸시 알림 Service Worker
├── package.json           ← Vercel API용 의존성
├── OPERATIONS.md          ← ★ 이 문서
├── api/
│   └── run-bot.js         ← Vercel serverless: 봇 트리거 (선택)
├── bot/
│   ├── package.json
│   ├── register-orders.js ← 선반랙 OMS 자동 등록
│   ├── register-cart.js   ← 카트사이트 자동 등록
│   ├── fetch-tracking.js  ← 선반랙 송장 수집
│   ├── fetch-cart-tracking.js ← 카트 송장 수집
│   ├── send-push.js       ← 12:35 마감 임박 푸시
│   ├── check-overdue.js   ← 72시간 미입금 알림
│   └── backup-orders.js   ← 월별 DB→CSV 백업
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

## 3. ⏰ 자동 실행 스케줄 (전체)

모두 **KST 기준 (UTC+9)**. 평일만 실행 (주말 휴무).

| 시간 (KST) | 봇 | 무엇 |
|---|---|---|
| **08:00** | 선반랙 + 카트 발주 | 새벽·아침에 모인 주문 처리 |
| **12:00** | 선반랙 + 카트 발주 | 점심 직전 1차 |
| **12:30** | 선반랙 + 카트 발주 | 점심 직전 2차 |
| **12:35** | 📲 푸시 알림 | "발주 마감 12:55 임박" |
| **12:51** | 선반랙 + 카트 발주 | 12:55 마감 직전 막판 |
| **17:00** | 송장 수집 (OMS + 카트) | 발송분 송장 자동 수집 |
| **17:30** | 송장 수집 | 추가 수집 |
| **18:00** | 송장 수집 | 마지막 수집 |
| 매일 **10:00** | 72H 미입금 체크 | 입력자에게 푸시 |
| 매월 1일 **02:00** | DB 백업 | bot/backups/YYYY-MM.csv 자동 커밋 |

---

## 4. 💾 데이터베이스 — Supabase 스키마

### 핵심 테이블

```sql
profiles (사용자 + 역할)
├── id (UUID, auth.users 참조)
├── email
├── display_name (한글 이름)
└── role ('admin' | 'input' | 'pending')

orders (주문 — 메인 데이터)
├── id (bigserial)
├── date (YYYY-MM-DD)
├── name (받는 사람)
├── tel (연락처)
├── addr (배송지)
├── product (선반랙 / 핸드카트)
├── color
├── qty (수량)
├── type ('택배' | '직거래')
├── amount (실제 받은 총액)
├── cost_price (매입가 — 트리거가 자동)
├── rep_price (개당 가격 — 트리거가 자동, amount/qty)
├── status ('접수' | '발주완료' | '발송완료')
├── paid (boolean)
├── paid_by (입금자명)
├── tracking (송장 번호)
├── shipped_at (발송 시각)
├── phone (휴대폰 별칭, 입력자 구분용)
├── nick (당근 닉네임)
├── memo (자유 메모)
├── bot_note (봇 실패 메시지)
├── created_by (입력자 UUID)
├── created_at
└── settled (정산 완료 여부)

products (상품 카탈로그)
├── name, color
├── default_cost (택배 원가)
├── default_cost_pickup (직거래 원가, null이면 위 사용)
└── default_rep_price (기본 판매가)

user_prices (입력자별 특별 단가)
├── user_id, product_name, color
└── rep_price

stock_receipts (입고 기록 — 배치별 원가 추적)
├── date, product, color, qty
├── purchase_unit (개당 매입가)
├── logistics_total (물류비 총액)
├── unit_cost (= 매입×수량 + 물류 ÷ 수량, 자동)
└── note

push_subscriptions (Web Push 구독)
├── user_id
└── endpoint, p256dh, auth
```

### SQL 마이그레이션 — 한 번에 실행 (idempotent)

새 환경 셋업하거나 누락 의심시 [Supabase SQL Editor](https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy/sql/new)에 통째로 붙여넣기:

```sql
-- 1) 상품 카탈로그 확장
alter table public.products add column if not exists default_cost_pickup int;

-- 2) 주문 컬럼 확장
alter table public.orders add column if not exists bot_note text;
alter table public.orders add column if not exists memo text;
alter table public.orders add column if not exists shipped_at timestamptz;
alter table public.orders add column if not exists settled boolean default false;

-- 3) 기본 상품
insert into public.products (name, color, default_cost, default_rep_price)
values ('핸드카트','블랙',28000,36000)
on conflict (name, color) do nothing;

-- 4) 입고 기록 테이블
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

-- 5) 입고 → 카탈로그 default_cost 자동 갱신 트리거
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

-- 6) 가격 자동 스냅샷 트리거 (가장 중요 — 마진 계산 정확성)
create or replace function public.snapshot_prices()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_cost int; v_rep int; v_role text;
begin
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
  if NEW.rep_price is null then
    select rep_price into v_rep from public.user_prices
    where user_id = NEW.created_by and product_name = NEW.product
      and ((color is null and NEW.color is null) or color = NEW.color) limit 1;
    if v_rep is null then
      select role into v_role from public.profiles where id = NEW.created_by;
      -- ⭐ 관리자 직접 입력: 개당 가격 = 받은총액/수량 (할인·네고 자동 반영)
      if v_role = 'admin' and NEW.amount is not null and coalesce(NEW.qty,1) > 0 then
        v_rep := (NEW.amount::float / coalesce(NEW.qty,1))::int;
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

### 잘못 들어간 마진 정정

만약 trigger 적용 전 입력된 주문이 잘못된 rep_price를 가지면:
```sql
-- 관리자 본인 입력 주문의 개당 가격 정정
UPDATE public.orders
SET rep_price = (amount::float / NULLIF(qty, 0))::int
WHERE created_by IN (SELECT id FROM public.profiles WHERE role='admin')
  AND amount IS NOT NULL AND amount > 0 AND qty > 0;
```

또는 앱의 **🎛 관리 모드 → 🔧 설정·도구 → 🔄 과거 주문 단가 재계산** 사용.

---

## 5. 🔐 비밀 키 보관 위치

| 키 | 어디 | 무엇용 |
|---|---|---|
| `OMS_USERNAME`, `OMS_PASSWORD` | GitHub Secrets | 봇이 dooldool6611 로그인 |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | GitHub Secrets | 봇이 DB 접근 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | GitHub Secrets | Web Push 알림 |
| `GITHUB_TOKEN` (선택) | localStorage 또는 Vercel env | 1클릭 봇 트리거 (선택) |

위치: https://github.com/SJ2424/danggn-order/settings/secrets/actions

⚠️ **VAPID 키 잃으면 모든 사용자가 알림 다시 켜야 함**. GitHub Secrets은 영구지만 백업 권장.

---

## 6. 👤 사용자 역할 시스템

| 역할 | 권한 |
|---|---|
| `admin` | 모든 주문 조회·수정·삭제, 카탈로그, 봇 실행, 모든 통계 |
| `input` | 본인 입력 주문만 조회·수정, 본인 정산 통계 |
| `pending` | 회원가입 후 대기 — 관리자 승인 필요 |
| `banned` | 차단 |

### 새 입력자 추가
1. 새 사람이 앱에서 회원가입 → role='pending'
2. 관리자 화면 우측 상단 [승인대기 N] 클릭 → 승인
3. 자동으로 role='input' 전환

### 관리자 권한 이전
```sql
update profiles set role='admin' where display_name='새관리자이름';
update profiles set role='input' where display_name='기존관리자이름';
```

### 비밀번호 잊었을 때
관리자: [Supabase Auth 페이지](https://supabase.com/dashboard/project/zmvllgztbqymwwfeprxy/auth/users) → 사용자 행 클릭 → Reset password

---

## 7. 📋 일상 운영 워크플로우

```
1. 손님 카톡 받음
   ↓
2. 앱 → ✏️ 주문 입력
   - 이름 / 전화 (전화 키패드 자동)
   - 🔍 카카오 주소 검색 → 정확한 주소 선택
   - 상세주소 (동/호)
   - 상품 dropdown · 색상 · 수량
   - 거래방식 · 받은 금액
   - [+ 주문 목록에 추가]
   ↓
3. 자동 (08:00 / 12:00 / 12:30 / 12:51)
   봇이 OMS·카트사이트에 자동 등록
   상태: 접수 → 발주완료
   ↓
4. 본인이 OMS 가서 결제·일괄주문·송금 (12:55 마감)
   ↓ 17~18시
5. 자동 송장 수집 → 발송완료 + 송장번호 채워짐
   ↓
6. 손님이 입금하면 → 카드의 [미입금] 알약 클릭 → 완료 ✅
```

**손님이 처음 보낼 채팅 자동 분석도 가능** — 입력 폼 위의 [📋 채팅 복붙 자동 분석] 펼침.

### 메모 활용
주문 카드의 📝 메모 칸: "단골 — 사은품 챙기기", "부재시 경비실", "할인 -2,000 적용" 등.
검색 가능 (예: "사은품" → 사은품 메모 있는 주문만).

---

## 8. 🚨 트러블슈팅

### 봇이 안 돌았어요
1. https://github.com/SJ2424/danggn-order/actions 가서 최근 실행 확인
2. 실패면 빨간 X → 클릭 → 어디서 막혔는지 로그 확인
3. 스크린샷 artifact 다운로드해서 실제 화면 확인 가능

### 주문이 OMS에 안 등록됐어요
- 카드에 빨간 **🤖 봇 메시지** 있는지 확인
- 주소 매칭 실패 (학연로 vs 학현로 등): 카드 [✏️ 수정] → 🔍 주소 검색 → 정확한 주소 선택 → 저장 → 다음 봇 실행
- 봇이 OMS 로그인 실패: GitHub Secrets의 `OMS_PASSWORD` 만료/변경 확인

### 송장이 안 채워져요
- 손님이 아직 발송 안 됐을 수 있음 (보통 발송 익일~익익일)
- OMS에서 송장 발급은 됐는데 봇이 못 잡음: 17:30 / 18:00 다시 시도됨
- 18:00 후에도 안 들어오면 카드 [📝 메모]에서 [✏️ 수정]으로 송장 수동 입력

### 마진이 이상해요
1. 카탈로그 [⚙️ 상품 가격] 확인 — 택배 원가/직거래 원가/기본 판매가 정확한지
2. **🔧 설정·도구 → 🔄 과거 주문 단가 재계산** 실행
3. 그래도 이상하면 위 SQL 마이그레이션 #6 (트리거) 재실행

### 푸시 알림 안 와요
- iPhone: 홈 화면에 PWA 추가했는지 확인 (Safari로 열어서 공유 → 홈 화면에 추가)
- 알림 권한: 설정 → 알림 → 「당근 발주 관리」 → 허용
- 앱 안에서 🔧 설정·도구 → 🔔 [이 기기 알림 켜기] 재클릭

### 앱이 흰화면
- 모바일: 강제 새로고침 (Safari: 주소창 길게 누름 → 새로고침)
- PC: `Ctrl+Shift+R`
- 그래도면 Vercel Deployments에서 이전 deployment [Promote to Production]

---

## 9. 💾 백업 정책

### 자동 (이미 작동)
- Supabase: 매일 DB 백업 (7일 보관, free tier)
- GitHub: 커밋마다 영구 (코드)
- bot/backup-orders.js: 매월 1일 02:00, `bot/backups/YYYY-MM.csv` 자동 커밋

### 수동 (월 1회 권장)
1. 앱 → 관리 모드 → 📒 장부 → **[📥 거래내역 CSV 다운로드]**
2. 파일명 예: `당근장부_전체_2026-05.csv`
3. PC + Google Drive (또는 다른 클라우드)에 둘 다 저장
4. 14일+ 지난 사고시 본인 CSV가 유일한 복구 수단

### 잃으면 안 되는 것
- Supabase 로그인 (잃으면 데이터 복구 불가)
- GitHub 로그인 (잃으면 코드·자동봇 손실)
- Vercel 로그인 (잃으면 앱 호스팅 손실, 단 GitHub에서 다시 연결 가능)

---

## 10. 🔧 코드 수정 / 봇 추가

새 기능이 필요하면:
1. **GitHub에서 직접 수정** (작은 변경): 파일 클릭 → ✏️ → commit → Vercel/Actions 자동 반영
2. **로컬 수정** (큰 변경): clone → 편집 → git push
3. **봇 추가**: `bot/new-bot.js` + `.github/workflows/new-bot.yml`

코드 구조는 위 §2 파일 트리 참고.

---

## 11. 🎯 시스템 디자인 결정 (왜 이렇게 만들었나)

운영하면서 의문 생기면 참고:

- **왜 Supabase + Vercel?** 무료 tier로 충분 + 한국에 인프라 있음 + 관리 쉬움
- **왜 GitHub Actions 봇?** 별도 서버 안 필요 + 무료 (월 2000분) + 자동 실행
- **왜 Playwright?** OMS·카트사이트가 API 안 제공 → 헤드리스 브라우저 자동화 필수
- **왜 rep_price = amount/qty?** 관리자 본인 직접 판매시 네고/할인까지 정확하게 마진 잡음
- **왜 접수 → 발주완료 직진?** 옛 발주대기 단계는 사용자가 까먹어서 송장 안 잡힘 → 단순화
- **왜 카카오 우편번호 embed?** PWA에서 팝업 차단되는 문제 + 검증 가능
- **왜 토큰 옵션은 깊이 숨김?** 99% 사용자는 자동 스케줄로 충분, 토큰은 1% 즉시실행 케이스

---

## 12. 🤖 AI/개발자에게 컨텍스트로 줄 때

새 채팅이나 다른 AI/개발자에게 시스템 도움 요청시 이 문서를 통째로 첨부.
다음 정보가 모두 들어 있어서 컨텍스트로 충분:

- 기술 스택 (§2)
- 자동 스케줄 (§3)
- DB 스키마 (§4)
- 사용자 역할 (§6)
- 워크플로우 (§7)
- 트러블슈팅 패턴 (§8)
- 디자인 결정 (§11)

추가로 필요하면:
- 최신 코드: https://github.com/SJ2424/danggn-order
- 최근 커밋 로그 (디버깅용)
- 실패 봇의 GitHub Actions 로그

---

## 13. 📞 핵심 contact

- 데이터·서비스 장애시: 본인이 Supabase/Vercel/GitHub 대시보드 직접 확인
- 코드 변경 필요시: GitHub PR 또는 AI에게 이 문서 첨부 + 요구사항
- 비밀번호 잊었을 때: 각 서비스의 비밀번호 재설정 (이메일 인증)

---

**END OF DOCUMENT**

마지막 커밋: 자동 발주 4시간(08·12·12:30·12:51) + 송장 3회(17·17:30·18:00) + 카드 inline 정리
시스템 상태: 운영 중 ✅
