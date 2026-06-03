# Бот @pp_fairy_bot на Amvera

## Шаг 6 в Amvera — что вписать

| Поле | Значение |
|------|----------|
| Окружение | `python` |
| Инструмент | `pip` |
| version | `3.11` |
| requirementsPath | `requirements.txt` |
| useCache | ✅ включено |
| **scriptName** | **`app.py`** |
| **command** | **пусто** |
| persistenceMount | `/data` (можно оставить) |
| **containerPort** | **`80`** |

Нажми **«Завершить»**, скачай `amvera.yaml` если предложат — он уже есть в этой папке.

## Залить код в git Amvera

```bash
cd integrations/amvera-bot
git clone https://git.msk0.amvera.ru/elena851/pp-fairy-bot.git
cd pp-fairy-bot
# скопируй сюда app.py, requirements.txt, amvera.yaml
git add app.py requirements.txt amvera.yaml
git commit -m "Initial bot"
git push
```

## Переменные в Amvera (проект → Переменные)

| Имя | Значение |
|-----|----------|
| `BOT_TOKEN` | токен @pp_fairy_bot |
| `LENA_CHAT_ID` | `6336708488` |
| `GAS_WEBHOOK_URL` | URL Apps Script (заказы с сайта) |
| `WEBHOOK_URL` | `https://pp-fairy-bot-....amvera.io` (домен проекта после деплоя) |
| `MINI_APP_URL` | `https://ппфея.рф` |

После первого деплоя в Telegram:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://ВАШ-ДОМЕН.amvera.io/webhook
```

И отключи polling в Apps Script (Run `enableTelegramPolling` больше не нужен — только GAS для таблицы).
