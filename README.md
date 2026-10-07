# V-Verify Cloudflare 배포 가이드

이 폴더는 Cloudflare Workers + Pages + MongoDB Atlas + Stripe 로 바로 프로덕션 서비스가 가능하게 구성됨.

## Architecture
```
[Pages: React Frontend] 
      |
      v
[Workers: Hono API] -> [MongoDB Atlas] (프로젝트 DB)
      |
      +-> [Stripe Checkout] -> Webhook -> Workers -> MongoDB 구독 업데이트
```

## 1) 사전 준비
- Cloudflare 계정 + Wrangler 로그인: `npx wrangler login`
- MongoDB Atlas 클러스터 생성 (Free M0) -> Connection String 복사
- Stripe Dashboard에서 Product 4개 생성
  - Basic $199, Pro $599, Enterprise $1500 (recurring), DataRoom $99 (one-time)

## 2) Workers 배포 (API)
```bash
cd v-verify-cloudflare
npm install

# Secrets 설정 (중요 - 코드에 키 넣지 말 것)
npx wrangler secret put MONGODB_URI
# 입력: mongodb+srv://user:pass@cluster...

npx wrangler secret put STRIPE_SECRET_KEY
# sk_test_... 또는 sk_live_...

npx wrangler secret put STRIPE_WEBHOOK_SECRET
# whsec_... (아래 3단계 후 생성)

npx wrangler secret put STRIPE_PRICE_BASIC
npx wrangler secret put STRIPE_PRICE_PRO
npx wrangler secret put STRIPE_PRICE_ENTERPRISE
npx wrangler secret put STRIPE_PRICE_DATAROOM

# 배포
npm run deploy
# 출력: https://v-verify-api.<subdomain>.workers.dev
```

## 3) Stripe Webhook 설정 (프로덕션)
- Stripe Dashboard > Developers > Webhooks > Add endpoint
- URL: https://v-verify-api.<subdomain>.workers.dev/api/webhook
- Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_failed
- 생성 후 Signing Secret (whsec_...) 복사 -> wrangler secret put STRIPE_WEBHOOK_SECRET

## 4) Frontend (Pages) 배포
- 기존 MVP 웹사이트 빌드 (Vite 기준)
```bash
# frontend 폴더에서
npm run build
# dist 폴더가 생성됨

# Pages 배포
npx wrangler pages deploy dist --project-name=v-verify
# 또는 Cloudflare Dashboard > Pages > Create > Upload
```

- Pages > Settings > Environment variables:
  - VITE_API_URL = https://v-verify-api.<subdomain>.workers.dev

## 5) wrangler.toml 수정
- FRONTEND_URL을 실제 Pages URL로 수정: https://v-verify.pages.dev
- 다시 deploy

## 6) 로컬 개발
```bash
npm run dev
# http://localhost:8787 에서 Worker 실행
# Frontend는 별도로 Vite dev 서버 실행, VITE_API_URL=http://localhost:8787
```

## 비용
- Cloudflare Workers: 월 10만 요청 무료, 이후 $5/10M
- Pages: 무제한 무료 (대역폭 제한 있음)
- MongoDB Atlas: M0 Free (512MB)
- Stripe: 결제당 3.4% + 수수료

=> 초기 월 $0~$5로 운영 가능

## 보안 체크리스트
- [ ] Stripe는 반드시 live 키로 교체 후 webhook secret도 live로 교체
- [ ] MONGODB_URI는 Atlas IP Allowlist에 0.0.0.0/0 허용 (Workers IP가 유동)
- [ ] CORS origin을 실제 Pages 도메인으로 제한 (worker.js에서 이미 설정됨)
- [ ] 관리자 페이지는 Cloudflare Access로 2차 보호 권장
