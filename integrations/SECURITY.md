# Чеклист безопасности «ПП Фея»

Бот от этого **не тормозит**. Секреты проверяются за миллисекунды.

## Сделано в коде
- [x] Токен бота убран из `Code.gs` (только Script Properties)
- [x] Заказы/allocate/lookup требуют `key` = `WEBHOOK_SECRET`
- [x] Антиспам: ~40 заказов/час, ~40 allocate/час
- [x] CF-прокси принимает заголовок `X-Tg-Proxy-Secret`
- [x] Бот на Amvera шлёт секрет прокси + ключ в GAS

## Сделай руками (порядок важен)

### 1) Сменить токен бота (критично)
1. BotFather → `/revoke` у `@pp_fairy_bot` → скопируй **новый** токен  
2. Amvera → переменная `BOT_TOKEN` = новый токен  
3. Apps Script → Script Properties → `BOT_TOKEN` = тот же новый токен  

### 2) Apps Script
Вставь обновлённый `integrations/apps-script/Code.gs` → **Сохранить**.  
Script Properties добавь/проверь:

| Имя | Значение |
|-----|----------|
| `BOT_TOKEN` | новый токен |
| `WEBHOOK_SECRET` | `LM7PuTO-xx2Syq5ooL-8QkhmpJ4jHZun37ilplN6uwk` |
| `LENA_CHAT_ID` | `6336708488` |
| `SHEET_ID` | id таблицы |

Развернуть → **Новое развёртывание** (или «Управление» → новую версию), доступ «Все».

Не включай `enableTelegramPolling` — бот на Amvera.

### 3) Cloudflare Worker
1. Workers → `restless-morning-ac62` → Edit code → вставь новый `src/index.js` → Deploy  
2. Settings → Variables → Add variable / Secret:  
   `PROXY_SECRET` = `7ak00clWDUnxnlgPQ3plDWgr5rVHpFqD`

### 4) Amvera (переменные)
```
TELEGRAM_API_BASE=https://restless-morning-ac62.papa3313.workers.dev/bot
TELEGRAM_PROXY_SECRET=7ak00clWDUnxnlgPQ3plDWgr5rVHpFqD
WEBHOOK_SECRET=LM7PuTO-xx2Syq5ooL-8QkhmpJ4jHZun37ilplN6uwk
BOT_TOKEN=<новый>
```
Залей обновлённый `app.py` → пересобери.

### 5) Сайт
В `index.html` уже есть `ORDER_WEBHOOK_SECRET` — нужен **push на GitHub Pages**.

### 6) Таблица Google
Доступ только аккаунтам Лены/тебе, не «все по ссылке».

## Проверка
1. Сайт: оформить тестовый заказ → уходит  
2. Бот: `/start` отвечает сразу  
3. Без ключа:  
   `curl "GAS_URL?action=allocate_order"` → `unauthorized`  
4. Прокси без секрета (после шага 3): запросы без заголовка → 401  

## Важно
Ключ в `index.html` виден в исходниках сайта — это нормально для статики.  
Он отсекает «тупой» спам по голому URL; жёсткая защита — **rate limit** + **revoke токена** + **секрет на CF**.
