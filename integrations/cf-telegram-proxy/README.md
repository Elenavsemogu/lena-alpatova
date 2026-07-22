# Cloudflare proxy для Telegram Bot API

Зачем: с Amvera (Москва) до `api.telegram.org` часто `ConnectTimeout`.
Бот ходит на Worker, Cloudflare стабильно достучивается до Telegram.

Секрет: переменная Worker `PROXY_SECRET` + заголовок `X-Tg-Proxy-Secret`
(на Amvera: `TELEGRAM_PROXY_SECRET`). Полный чеклист: [`../SECURITY.md`](../SECURITY.md).

## URL сейчас
`https://restless-morning-ac62.papa3313.workers.dev`

Amvera:
```
TELEGRAM_API_BASE=https://restless-morning-ac62.papa3313.workers.dev/bot
TELEGRAM_PROXY_SECRET=<как PROXY_SECRET на Worker>
```

## Обновить код Worker
Dashboard → Worker → Edit code → вставь `src/index.js` → Deploy  
Settings → Variables → Secret `PROXY_SECRET`

## CLI
```bash
cd integrations/cf-telegram-proxy
npm install
npx wrangler login
npx wrangler secret put PROXY_SECRET
npx wrangler deploy
```
