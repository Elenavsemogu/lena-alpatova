# Подключение бота @pp_fairy_bot к сайту

## Почему webhook на Apps Script «ломается» (302 / 405)

Это **не баг нашего кода** — так устроен Google Apps Script Web App:

| URL | Что делает Telegram (POST) |
|-----|----------------------------|
| `script.google.com/.../exec` | Отвечает **302** редиректом → Telegram считает ошибкой |
| `script.googleusercontent.com/...` | На POST отвечает **405** (разрешены только GET/HEAD) |

**Другие наши боты** (HR Boost, Secretroom) работают через **polling** (`getUpdates`) или через **сервер** (Node на Render с `POST /webhook` → сразу `200`). Там нет редиректов Google.

**Для ПП Феи:** сайт → GAS (заказы в таблицу) оставляем как есть. Диалог в Telegram — через **polling** в Apps Script: один раз `enableTelegramPolling` + триггер раз в минуту.

---

Токен уже прописан в `Code.gs`. Дальше — шаги ниже.

---

## Шаг 1 — Узнать свой chat_id

1. Открой Telegram с аккаунта Лены
2. Напиши боту `@pp_fairy_bot` любое сообщение (например `/start`)
3. Этот chat_id нужен для шага 3

---

## Шаг 2 — Создать Google Таблицу

1. Открой [sheets.google.com](https://sheets.google.com) и создай новую таблицу
2. Назови её, например: **«ПП Фея — Заказы»**
3. Скопируй **Spreadsheet ID** из адресной строки:
   ```
   https://docs.google.com/spreadsheets/d/ВОТ_ЭТА_ЧАСТЬ_ID/edit
   ```

---

## Шаг 3 — Создать Apps Script и задеплоить

1. Открой [script.google.com](https://script.google.com) → **Новый проект**
2. Удали весь код в `Code.gs` и вставь содержимое файла `integrations/apps-script/Code.gs`
3. Перейди в **Настройки проекта (шестерёнка)** → **Свойства скрипта** → добавь:
   | Имя | Значение |
   |-----|----------|
   | `BOT_TOKEN` | `8708408440:AAHVJZOI4dAKShpcMX-oqJ8aY2R6GZvdrB8` |
   | `LENA_CHAT_ID` | *(узнаём ниже)* |
   | `SHEET_ID` | ID таблицы из шага 2 |
   | `SHEET_ORDERS` | `Orders` |
   | `SHEET_FORMS` | `Forms` |

4. **Узнать LENA_CHAT_ID:**
   - Убедись, что написала `/start` боту (шаг 1)
   - В редакторе скрипта выбери функцию `getMyLenaChatId` и нажми **▶ Выполнить**
   - В логах (Вид → Журналы) будет число — это твой `chat_id`, запиши его в Script Properties как `LENA_CHAT_ID`

5. **Задеплоить Web App:**
   - Нажми **Развернуть → Новое развёртывание**
   - Тип: **Веб-приложение**
   - Выполнять от имени: **Меня**
   - Доступ: **Все**
   - Нажми **Развернуть** и скопируй **URL веб-приложения** (это `WEBHOOK_URL`)

---

## Шаг 4 — Вставить WEBHOOK_URL в сайт

Открой `index.html`, найди строку:
```js
const ORDER_WEBHOOK_URL = '';
```
И вставь туда полученный URL:
```js
const ORDER_WEBHOOK_URL = 'https://script.google.com/macros/s/ВАШ_ID/exec';
```
Потом запушь изменения на GitHub.

---

## Включить бота (без webhook)

1. В Script Properties добавь `LENA_CHAT_ID` (число Лены; **для теста** можно временно `473640248` — аккаунт Елены, потом заменить на chat_id Лены).
2. В редакторе: в списке функций сверху выбери **`enableTelegramPolling`** → **▶ Выполнить** → разреши доступ.
3. Готово: бот будет опрашивать Telegram раз в минуту и отвечать на `/start` и кнопки.

## Проверка

Запусти `testSendToLena` — Лена должна получить «✅ Тест пройден!».
