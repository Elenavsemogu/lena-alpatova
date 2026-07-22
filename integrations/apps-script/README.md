# Подключение бота @pp_fairy_bot к сайту

Актуальная схема (2026-07):
- **Диалог в Telegram** → Amvera (`integrations/amvera-bot/`) + Cloudflare proxy
- **Заказы с сайта** → Apps Script Web App → Google Sheets + уведомление Лене

Безопасность и чеклист: [`../SECURITY.md`](../SECURITY.md)

---

## Почему webhook Telegram → Apps Script не используем

| URL | Что делает Telegram (POST) |
|-----|----------------------------|
| `script.google.com/.../exec` | **302** → ошибка |
| `script.googleusercontent.com/...` | **405** |

Бот на Amvera работает через **polling**. В GAS **не** включай `enableTelegramPolling`.

---

## Script Properties

| Имя | Значение |
|-----|----------|
| `BOT_TOKEN` | токен из BotFather (**не** хранить в git / Code.gs) |
| `WEBHOOK_SECRET` | тот же, что `ORDER_WEBHOOK_SECRET` в `index.html` |
| `LENA_CHAT_ID` | chat_id Лены |
| `SHEET_ID` | id таблицы |
| `SHEET_ORDERS` | `Orders` |
| `SHEET_FORMS` | `Forms` |

## Деплой Web App

1. Вставь `Code.gs` → Сохранить  
2. Развернуть → Новое развёртывание → Веб-приложение → от имени **Меня**, доступ **Все**  
3. URL → `ORDER_WEBHOOK_URL` в `index.html` и `GAS_WEBHOOK_URL` на Amvera  

## Сайт

```js
const ORDER_WEBHOOK_URL = 'https://script.google.com/macros/s/.../exec';
const ORDER_WEBHOOK_SECRET = '...'; // = WEBHOOK_SECRET в Script Properties
```
