# Бот @pp_fairy_bot на Amvera — инструкция с нуля

Проект **pp-fairy-bot** в Amvera ты уже создала. Файл конфигурации Amvera отдаёт как **`amvera.yml`** (не `amvera.yaml`) — положи его в **корень** репозитория вместе с кодом.

Готовые файлы лежат здесь: `integrations/amvera-bot/`  
- `app.py`  
- `requirements.txt`  
- `amvera.yml` (совпадает с тем, что скачала из Amvera)

---

## Шаг 1. Склонировать репозиторий Amvera на компьютер

Открой **Терминал** и выполни (одной строкой за раз):

```bash
cd ~/Desktop
git clone https://git.msk0.amvera.ru/elena851/pp-fairy-bot.git
cd pp-fairy-bot
```

Если спросит логин/пароль — используй данные от Amvera (или токен из личного кабинета Amvera → Git).

---

## Шаг 2. Положить файлы в папку проекта

Скопируй **в папку `pp-fairy-bot`** (в корень, рядом друг с другом):

| Откуда | Куда |
|--------|------|
| `lena-alpatova/integrations/amvera-bot/app.py` | `pp-fairy-bot/app.py` |
| `lena-alpatova/integrations/amvera-bot/requirements.txt` | `pp-fairy-bot/requirements.txt` |
| Скачанный **`amvera.yml`** из Downloads **или** наш `integrations/amvera-bot/amvera.yml` | `pp-fairy-bot/amvera.yml` |

В итоге в `pp-fairy-bot` должно быть **ровно 3 файла** в корне:

```
pp-fairy-bot/
  app.py
  requirements.txt
  amvera.yml
```

Папку `venv` не копируй.

---

## Шаг 3. Отправить в Amvera (git push)

В терминале, находясь в `pp-fairy-bot`:

```bash
git add app.py requirements.txt amvera.yml
git commit -m "Первый деплой бота ПП Фея"
git push
```

После push Amvera сама начнёт сборку. Подожди 2–5 минут, статус в личном кабинете → проект **pp-fairy-bot** → **«Сборка» / «Приложение запущено»**.

---

## Шаг 4. Переменные окружения в Amvera

Готовый файл для импорта: **`integrations/amvera-bot/pp-fairy-bot.env`** (токен и URL уже заполнены; `WEBHOOK_URL` — после появления домена).

В [cloud.amvera.ru](https://cloud.amvera.ru) → проект **pp-fairy-bot** → **Переменные** → **импорт / подгрузить .env** → выбери `pp-fairy-bot.env` → перезапуск.

Или вручную:

| Имя | Значение |
|-----|----------|
| `BOT_TOKEN` | токен бота @pp_fairy_bot |
| `LENA_CHAT_ID` | `6336708488` |
| `GAS_WEBHOOK_URL` | `https://script.google.com/macros/s/AKfycbyOs9GPu_hi6GSFCxlVmezgvrO2B8sM1U3SNQ0oTyRuzcPIgDsVo9ydd3Xh234BEj7ECg/exec` |
| `MINI_APP_URL` | `https://ппфея.рф` |
| `WEBHOOK_URL` | домен проекта **без** `/webhook` (см. шаг 5) |

Сохрани и **перезапусти** приложение, если Amvera просит.

---

## Шаг 5. Узнать домен и включить webhook Telegram

1. В Amvera открой проект → раздел с **URL / доменом** (что-то вроде `https://pp-fairy-bot-....amvera.io`).
2. Скопируй этот адрес **без слэша в конце** → вставь в переменную `WEBHOOK_URL`.
3. В браузере открой (подставь свой токен и домен):

```
https://api.telegram.org/bot<ВСТАВЬ_BOT_TOKEN>/setWebhook?url=https%3A%2F%2F<ВАШ-ДОМЕН>.amvera.io%2Fwebhook
```

Пример: если домен `https://pp-fairy-bot-run-elena851.amvera.io`, то webhook:

`https://pp-fairy-bot-run-elena851.amvera.io/webhook`

4. Проверка: напиши боту `/start` — ответ должен прийти **сразу** (секунды, не минута).

---

## Что остаётся на Google Apps Script

- **Сайт** шлёт заказы в `GAS_WEBHOOK_URL` → таблица + уведомление Лене.
- **Бот в Telegram** (меню, /start, Mini App, быстрые ответы) — на **Amvera**.

В Apps Script **не нужен** polling (`enableTelegramPolling`) после того, как webhook на Amvera работает — иначе два источника будут драться за сообщения.

---

## Если бот отвечает заглушками («напишите @elenappdeserty» на всё)

Значит на Amvera **старая версия** `app.py`. Обнови файл из `integrations/amvera-bot/app.py` (через git push или «Через интерфейс») и дождись пересборки.

После обновления:
- **❓ Частые вопросы** → меню из 6 тем (ингредиенты, оплата, доставка…)
- **💬 Написать Елене** → следующее сообщение уходит Лене в личку
- **📝 Анкета** → 3 вопроса → Google Sheets через `GAS_WEBHOOK_URL`

---

## Если что-то пошло не так

| Проблема | Что сделать |
|----------|-------------|
| Ошибка 502 | В `app.py` сервер слушает `0.0.0.0:80` — уже так; проверь `containerPort: "80"` в `amvera.yml` |
| Бот молчит | Проверь `setWebhook` и переменную `WEBHOOK_URL` |
| Сборка падает | В логах Amvera — часто нет `requirements.txt` или не тот путь |

---

## Краткий чеклист

- [ ] `git clone` → скопировать 3 файла → `git push`
- [ ] Переменные `BOT_TOKEN`, `LENA_CHAT_ID`, `GAS_WEBHOOK_URL`, `WEBHOOK_URL`
- [ ] `setWebhook` на `https://ДОМЕН/webhook`
- [ ] Тест: `/start` и `/myid` в боте
