# V-Verify (lotmark) — Cloudflare 수익화 배포 가이드

Cloudflare Workers + Pages + MongoDB Atlas + **Stripe** 로 구독·DataRoom 결제가 동작하는 베트남 프로젝트 검증 API/앱입니다.

> 리포지토리 이름: `lotmark` · 런타임 이름: `v-verify-api`  
> `luna-chat-coder` (`.agents/`)는 개발 보조 도구이며 제품 코드가 아닙니다.

## Architecture

```
[Pages: frontend/index.html]
      |
      v
[Workers: Hono API] -> [MongoDB Atlas]
      |
      +-> [Stripe Checkout / Portal / Webhook] -> plan · dataRoom 동기화
```

### 구현된 수익화 기능 (Phase 1)

| 기능 | 엔드포인트 |
|------|------------|
| 이메일 로그인·토큰 발급 | `POST /api/auth/login` |
| 내 플랜 조회 | `GET /api/me` |
| Stripe Checkout | `POST /api/checkout` `{ priceKey, projectId? }` |
| Stripe Webhook | `POST /api/webhook` |
| Customer Portal | `POST /api/portal` |
| 플랜별 프로젝트 마스킹 | `GET /api/projects`, `GET /api/projects/:id` |

`priceKey`: `basic` | `pro` | `enterprise` | `dataroom`

---

## 즉시 실행 순서 (운영자가 해야 할 일)

코드는 이미 리포에 반영되어 있습니다. 아래 **계정/시크릿 작업만** 순서대로 수행하세요.

### 1) Stripe Product / Price 생성

Stripe Dashboard → Products → 다음 4개 생성:

| 이름 | 유형 | 권장 금액 | 비고 |
|------|------|-----------|------|
| V-Verify Basic | Recurring monthly | $199 | Price ID → `STRIPE_PRICE_BASIC` |
| V-Verify Pro | Recurring monthly | $599 | → `STRIPE_PRICE_PRO` |
| V-Verify Enterprise | Recurring monthly | $1,500 | → `STRIPE_PRICE_ENTERPRISE` |
| V-Verify DataRoom | One-time | $99 | → `STRIPE_PRICE_DATAROOM` |

각 **Price ID** (`price_...`)를 복사해 둡니다. 테스트는 `sk_test_` / test mode Price 사용.

### 2) Cloudflare 로그인 & Workers 시크릿

```bash
npm install
npx wrangler login

npx wrangler secret put MONGODB_URI
# mongodb+srv://...

npx wrangler secret put STRIPE_SECRET_KEY
# sk_test_... 또는 sk_live_...

npx wrangler secret put STRIPE_PRICE_BASIC
npx wrangler secret put STRIPE_PRICE_PRO
npx wrangler secret put STRIPE_PRICE_ENTERPRISE
npx wrangler secret put STRIPE_PRICE_DATAROOM
```

`STRIPE_WEBHOOK_SECRET` 은 3단계 후 등록합니다.

### 3) Workers 배포

```bash
npm run deploy
# 예: https://v-verify-api.<subdomain>.workers.dev
```

`wrangler.toml` 의 `FRONTEND_URL` 을 실제 Pages URL로 맞춘 뒤 재배포하세요.

### 4) Stripe Webhook

Stripe Dashboard → Developers → Webhooks → Add endpoint

- URL: `https://v-verify-api.<subdomain>.workers.dev/api/webhook`
- Events:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`
- Signing secret (`whsec_...`) 복사 후:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 5) Frontend (Pages) 배포

`frontend/index.html` 안의 `window.__API_BASE__` 기본값을 실제 Worker URL로 바꾸거나, 배포 후 브라우저 콘솔에서:

```js
localStorage.setItem('vv_api', 'https://v-verify-api.<subdomain>.workers.dev');
location.reload();
```

```bash
npx wrangler pages deploy frontend --project-name=v-verify
```

### 6) 스모크 테스트

1. Pages 접속 → 이메일 로그인  
2. 프로젝트 목록 (시드 데이터가 없으면 `POST /api/projects` 로 샘플 생성)  
3. Basic/Pro 구독 버튼 → Stripe Checkout (test card `4242...`)  
4. 성공 후 `/api/me` 또는 UI 배지에서 plan 변경 확인  
5. 상세 조회 시 free 마스킹 해제 확인  
6. DataRoom 버튼으로 문서 URL 잠금 해제 확인  

### 샘플 프로젝트 시드 (curl)

```bash
export API=https://v-verify-api.<subdomain>.workers.dev
export TOKEN=... # 로그인 후 localStorage vv_token

curl -s -X POST "$API/api/projects" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Thu Duc Industrial Sample",
    "region": "HCMC",
    "type": "industrial",
    "areaSqm": 50000,
    "priceUsd": 12000000,
    "sellerCompany": { "name": "ABC Land", "taxCode": "0312345678", "blacklist": false },
    "sources": [
      { "docType": "IRC", "fileUrl": "https://example.com/irc.pdf", "trustScore": 90, "isOfficial": true },
      { "docType": "ERC", "fileUrl": "https://example.com/erc.pdf", "trustScore": 85, "isOfficial": true },
      { "docType": "LURC", "fileUrl": "https://example.com/lurc.pdf", "trustScore": 80, "isOfficial": true },
      { "docType": "FIELD_PHOTO", "fileUrl": "https://example.com/1.jpg", "trustScore": 70, "isOfficial": false },
      { "docType": "FIELD_PHOTO", "fileUrl": "https://example.com/2.jpg", "trustScore": 70, "isOfficial": false },
      { "docType": "FIELD_PHOTO", "fileUrl": "https://example.com/3.jpg", "trustScore": 70, "isOfficial": false }
    ],
    "verifiedFacts": "IRC/ERC/LURC 확인",
    "gps": { "raw": "10.8500, 106.7500" }
  }'
```

---

## 로컬 개발

```bash
npm install
npx wrangler secret put MONGODB_URI   # 또는 .dev.vars
npm run dev   # http://localhost:8787
```

프론트: `frontend/index.html` 을 정적 서버로 열고 `localStorage.vv_api = 'http://localhost:8787'`.

`.dev.vars` 예시:

```
MONGODB_URI=mongodb+srv://...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_BASIC=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_ENTERPRISE=price_...
STRIPE_PRICE_DATAROOM=price_...
FRONTEND_URL=http://localhost:5173
```

Webhook 로컬 테스트: `stripe listen --forward-to localhost:8787/api/webhook`

---

## 비용

- Cloudflare Workers: 월 10만 요청 무료 이후 $5/10M  
- Pages: 무료 티어 충분  
- MongoDB Atlas M0: Free  
- Stripe: 결제 수수료  

초기 인프라 ≈ $0–5/월.

## 보안 체크리스트

- [ ] Live 전환 시 `sk_live_` + live Price + live webhook secret 교체  
- [ ] Atlas Network Access에 `0.0.0.0/0` (Workers IP 유동)  
- [ ] CORS / `FRONTEND_URL` 실제 도메인 고정  
- [ ] 관리자 기능 추가 시 Cloudflare Access 권장  
- [ ] MVP 이메일 토큰은 프로덕션에서 Magic Link / OAuth 로 교체 권장  

## License

MIT — see LICENSE.
