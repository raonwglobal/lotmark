# V-Verify (lotmark) — Cloudflare 수익화 앱

Cloudflare Workers + Pages + MongoDB Atlas + Stripe.  
베트남 프로젝트 문서 검증(A~E 등급) + 구독/DataRoom 결제.

> 리포: `lotmark` · Worker: `v-verify-api`  
> `.agents/luna-chat-coder` 는 개발 보조 도구이며 제품 코드가 아닙니다.

## Architecture

```
[Pages: frontend/index.html]
      → [Workers Hono API] → [MongoDB Atlas]
      → [Stripe Checkout / Portal / Webhook]
```

## Phase 1 — 수익화 (완료)

| 기능 | 엔드포인트 |
|------|------------|
| 로그인·토큰 | `POST /api/auth/login` |
| 내 정보 | `GET /api/me` |
| Checkout | `POST /api/checkout` `{ priceKey, projectId? }` |
| Webhook | `POST /api/webhook` |
| Portal | `POST /api/portal` |
| 플랜 게이팅 | `GET /api/projects`, `/:id` |

`priceKey`: `basic` | `pro` | `enterprise` | `dataroom`

## Phase 2 — 운영·검증 워크플로 (완료)

| 기능 | 엔드포인트 |
|------|------------|
| 프로젝트 생성(자동 등급) | `POST /api/projects` |
| 프로젝트 수정(재등급) | `PUT /api/projects/:id` |
| 출처 추가(재등급) | `POST /api/projects/:id/sources` |
| 샘플 시드 | `POST /api/seed` |
| API 토큰 재발급 (Pro+) | `POST /api/auth/rotate-token` |
| 관리자 사용자 목록 | `GET /api/admin/users` |
| 블랙리스트 | `POST /api/admin/blacklist` |
| 공개/비공개 | `POST /api/admin/visibility` |
| docType 목록 | `GET /api/meta/doc-types` |

관리자: `ADMIN_EMAILS` 시크릿(콤마 구분 이메일) 또는 User.role=`admin`.

docType: `IRC` `ERC` `LURC` `DPI_PORTAL` `FIELD_PHOTO` `GOV_DOC` `NEWS` `SELLER_DOC`

---

## 배포 순서 (운영자)

### 1) Stripe Products

| 이름 | 유형 | 금액 | Secret |
|------|------|------|--------|
| Basic | monthly | $199 | `STRIPE_PRICE_BASIC` |
| Pro | monthly | $599 | `STRIPE_PRICE_PRO` |
| Enterprise | monthly | $1500 | `STRIPE_PRICE_ENTERPRISE` |
| DataRoom | one-time | $99 | `STRIPE_PRICE_DATAROOM` |

### 2) Secrets

```bash
npm install
npx wrangler login
npx wrangler secret put MONGODB_URI
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_PRICE_BASIC
npx wrangler secret put STRIPE_PRICE_PRO
npx wrangler secret put STRIPE_PRICE_ENTERPRISE
npx wrangler secret put STRIPE_PRICE_DATAROOM
npx wrangler secret put ADMIN_EMAILS
# 예: you@company.com,ops@company.com
```

Webhook 등록 후:

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

### 3) Deploy

```bash
# wrangler.toml FRONTEND_URL 수정
npm run deploy
npx wrangler pages deploy frontend --project-name=v-verify
```

프론트 API URL:

```js
localStorage.setItem('vv_api', 'https://v-verify-api.<subdomain>.workers.dev');
```

### 4) Stripe Webhook

URL: `https://v-verify-api.<subdomain>.workers.dev/api/webhook`  
Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

### 5) 스모크

1. 이메일 로그인  
2. 「샘플 시드」 → Grade A / C 샘플  
3. 프로젝트 상세 · 출처 추가 → 재등급  
4. Basic Checkout (test `4242…`)  
5. ADMIN_EMAILS 계정으로 블랙리스트·사용자 목록  

---

## 로컬

```bash
npm install
# .dev.vars 에 MONGODB_URI, STRIPE_*, ADMIN_EMAILS, FRONTEND_URL
npm run dev
```

`stripe listen --forward-to localhost:8787/api/webhook`

## 보안

- Live 키·Price·webhook secret 교체 후 운영  
- Atlas `0.0.0.0/0` (Workers IP 유동)  
- MVP 이메일 토큰 → 이후 Magic Link/OAuth 권장  
- 관리자 페이지는 Cloudflare Access 추가 권장  

## License

MIT
