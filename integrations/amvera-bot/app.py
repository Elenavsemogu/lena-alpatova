"""
@pp_fairy_bot на Amvera — polling (getUpdates).

Переменные:
  BOT_TOKEN, LENA_CHAT_ID, GAS_WEBHOOK_URL, MINI_APP_URL
  TELEGRAM_API_BASE — опционально, прокси Cloudflare:
    https://pp-fairy-tg-proxy.<subdomain>.workers.dev/bot
"""
import asyncio
import logging
import os
import threading
from urllib.parse import urlencode

import aiohttp
from aiohttp import web
from telegram import (
    BotCommand,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    MenuButtonWebApp,
    ReplyKeyboardMarkup,
    Update,
    WebAppInfo,
)
from telegram.error import TimedOut, NetworkError, Conflict, RetryAfter
from telegram.request import HTTPXRequest
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s:%(name)s:%(message)s",
)
log = logging.getLogger(__name__)
# httpx пишет полный URL с токеном — режем до WARNING
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
LENA_CHAT_ID = os.environ.get("LENA_CHAT_ID", "6336708488")
GAS_WEBHOOK_URL = os.environ.get("GAS_WEBHOOK_URL", "")
MINI_APP_URL = os.environ.get("MINI_APP_URL", "https://xn--e1atau0d.xn--p1ai/")
PORT = int(os.environ.get("PORT", "80"))
ELENA_USERNAME = "@elenappdeserty"
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
TELEGRAM_PROXY_SECRET = os.environ.get("TELEGRAM_PROXY_SECRET", "")
# По умолчанию официальный API; на Amvera Москва часто ConnectTimeout —
# ставим Cloudflare Worker: .../bot (без слэша в конце).
TELEGRAM_API_BASE = (
    os.environ.get("TELEGRAM_API_BASE", "https://api.telegram.org/bot").rstrip("/")
)
if not TELEGRAM_API_BASE.endswith("/bot"):
    # допускаем URL вида https://xxx.workers.dev → дописываем /bot
    TELEGRAM_API_BASE = TELEGRAM_API_BASE.rstrip("/") + "/bot"

MENU_BUTTONS = frozenset(
    {
        "❓ Частые вопросы",
        "📦 Мой заказ",
        "💬 Написать Елене",
        "📝 Анкета",
    }
)

FAQ_TEXT = {
    "ingredients": (
        "Только натуральные ингредиенты:\n\n"
        "🌾 Мука: бурого риса, полбяная, овсяная, цельнозерновая\n"
        "🍯 Вместо сахара: эритритол (ГИ = 0)\n"
        "🍫 Шоколад без сахара\n"
        "🍞 Хлеб на закваске\n\n"
        "Без добавок и усилителей вкуса."
    ),
    "pay": (
        "💳 Оплата:\n\n"
        "• Предоплата 1 000–2 000 ₽ при оформлении\n"
        "• Перевод на карту (реквизиты пришлём после заказа)\n"
        "• Остаток — при получении"
    ),
    "delivery": (
        "🚚 Доставка по Барнаулу: 300–500 ₽, время по договорённости.\n\n"
        "📍 Самовывоз: Павловский тракт 229"
    ),
    "today": (
        "⏰ Часто можем приготовить и привезти уже сегодня — "
        "зависит от загрузки. Чем раньше закажете, тем больше вариантов!"
    ),
    "diabetes": "✅ Да! Эритритол (ГИ = 0) вместо сахара, мука с низким ГИ.",
    "allergy": (
        "✅ Делаем без молока (веган) и без глютена — "
        "уточните при заказе в комментарии."
    ),
}


def ud(context: ContextTypes.DEFAULT_TYPE) -> dict:
    if context.user_data is None:
        return {}
    return context.user_data


async def tg_retry(coro_factory, *, label: str = "tg", attempts: int = 5):
    """Повторы при ConnectTimeout/NetworkError Amvera↔Telegram."""
    last_err = None
    for i in range(1, attempts + 1):
        try:
            return await coro_factory()
        except RetryAfter as err:
            wait = float(getattr(err, "retry_after", 1) or 1) + 0.2
            log.warning("%s RetryAfter %.1fs (%s/%s)", label, wait, i, attempts)
            await asyncio.sleep(wait)
            last_err = err
        except (TimedOut, NetworkError, OSError) as err:
            wait = min(0.35 * (2 ** (i - 1)), 4.0)
            log.warning("%s %s (%s/%s), retry in %.1fs", label, type(err).__name__, i, attempts, wait)
            last_err = err
            await asyncio.sleep(wait)
    raise last_err


async def reply_text(message, text: str, **kwargs):
    return await tg_retry(
        lambda: message.reply_text(text, **kwargs),
        label="reply_text",
    )


async def send_text(bot, chat_id: int, text: str, **kwargs):
    return await tg_retry(
        lambda: bot.send_message(chat_id=chat_id, text=text, **kwargs),
        label="send_message",
    )


def main_keyboard():
    return ReplyKeyboardMarkup(
        [
            [KeyboardButton("🍰 Открыть каталог", web_app=WebAppInfo(url=MINI_APP_URL))],
            ["❓ Частые вопросы", "📦 Мой заказ"],
            ["💬 Написать Елене", "📝 Анкета"],
        ],
        resize_keyboard=True,
        is_persistent=True,
    )


def faq_keyboard():
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("Из чего готовите?", callback_data="faq:ingredients")],
            [InlineKeyboardButton("Как оплатить?", callback_data="faq:pay")],
            [InlineKeyboardButton("Доставка и самовывоз", callback_data="faq:delivery")],
            [InlineKeyboardButton("Можно на сегодня?", callback_data="faq:today")],
            [InlineKeyboardButton("Для диабетиков", callback_data="faq:diabetes")],
            [InlineKeyboardButton("Без молока / глютена", callback_data="faq:allergy")],
            [InlineKeyboardButton("← Назад", callback_data="menu:back")],
        ]
    )


async def send_welcome(update: Update):
    text = (
        "Здравствуйте! Я помощник Елены — «ПП Фея» 🧁\n\n"
        "Торты, десерты, конфеты и выпечка из натуральных ингредиентов.\n"
        "Без сахара · Без белой муки · Барнаул\n\n"
        "Нажмите «🍰 Открыть каталог» — это сайт прямо в Telegram."
    )
    await reply_text(update.effective_message, text, reply_markup=main_keyboard())


async def send_faq_menu(update: Update):
    await reply_text(
        update.effective_message,
        "Частые вопросы — выберите тему:",
        reply_markup=faq_keyboard(),
    )


async def fetch_order(order_id: str):
    if not GAS_WEBHOOK_URL:
        return None
    qs_data = {"action": "order_lookup", "orderId": order_id}
    if WEBHOOK_SECRET:
        qs_data["key"] = WEBHOOK_SECRET
    qs = urlencode(qs_data)
    url = f"{GAS_WEBHOOK_URL}?{qs}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=aiohttp.ClientTimeout(total=20)) as resp:
                data = await resp.json(content_type=None)
                if data.get("ok") and data.get("order"):
                    return data["order"]
    except Exception as err:
        log.warning("Order lookup failed for %s: %s", order_id, err)
    return None


def format_order_status(order: dict) -> str:
    lines = ["Ваш заказ уже принят на сайте ✅"]
    oid = order.get("orderId") or ""
    if oid:
        lines.append(f"Номер: {oid}")
    lines.append("")
    lines.append("Позиции:")
    for it in order.get("items") or []:
        name = it.get("name") or "Позиция"
        variant = it.get("variant") or ""
        qty = it.get("qty") or 1
        suffix = f" ({variant})" if variant else ""
        lines.append(f"— {name}{suffix} × {qty}")
    totals = order.get("totals") or {}
    lines.append("")
    lines.append(f"Сумма: {totals.get('price', 0)} ₽")
    lines.append("")
    lines.append("Елена свяжется с вами в ближайшее время.")
    lines.append(f"Если нужно что-то изменить — {ELENA_USERNAME}")
    return "\n".join(lines)


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    parts = text.split()
    if len(parts) > 1 and parts[1].startswith("order_"):
        order_id = parts[1].replace("order_", "", 1)
        order = await fetch_order(order_id)
        if order:
            await reply_text(
                update.message,
                format_order_status(order),
                reply_markup=main_keyboard(),
            )
        else:
            await reply_text(
                update.message,
                f"Заказ принят ✅\nНомер: {order_id}\n\n"
                f"Елена свяжется с вами в ближайшее время.\n"
                f"Если нужно что-то изменить — {ELENA_USERNAME}",
                reply_markup=main_keyboard(),
            )
        return
    ud(context).pop("mode", None)
    await send_welcome(update)


async def cmd_catalog(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_welcome(update)


async def cmd_faq(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await send_faq_menu(update)


async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cid = update.effective_chat.id
    await reply_text(
        update.message,
        f"Ваш chat_id: {cid}\n\n"
        "Если вы Лена — отправьте это число в настройки бота.",
        reply_markup=main_keyboard(),
    )


async def forward_client_message(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    user = update.effective_user
    lines = ["💬 Сообщение от клиента", ""]
    name = (user.full_name if user else None) or "Клиент"
    if user and user.username:
        lines.append(name + f" (@{user.username})")
    else:
        lines.append(name)
    lines.append(f"chat_id: {update.effective_chat.id}")
    lines.append("")
    lines.append(text)
    body = "\n".join(lines)
    try:
        await send_text(context.bot, int(LENA_CHAT_ID), body)
        await reply_text(
            update.message,
            "Передала Елене ✅ Она ответит вам здесь или в личке.\n\n"
            f"Или напишите напрямую: {ELENA_USERNAME}",
            reply_markup=main_keyboard(),
        )
    except Exception as err:
        log.exception("Forward to Lena failed: %s", err)
        await reply_text(
            update.message,
            f"Не удалось передать сообщение автоматически.\n"
            f"Напишите Елене: {ELENA_USERNAME}",
            reply_markup=main_keyboard(),
        )
    ud(context).pop("mode", None)


async def submit_questionnaire(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    answers = ud(context).get("anketa", {})
    payload = {
        "type": "questionnaire",
        "source": "telegram_bot",
        "client": {
            "tgUserId": str(update.effective_chat.id),
            "username": (user.username if user else "") or "",
            "firstName": (user.first_name if user else "") or "",
            "lastName": (user.last_name if user else "") or "",
        },
        "answers": answers,
    }
    if GAS_WEBHOOK_URL:
        try:
            body = dict(payload)
            if WEBHOOK_SECRET:
                body["key"] = WEBHOOK_SECRET
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    GAS_WEBHOOK_URL,
                    json=body,
                    timeout=aiohttp.ClientTimeout(total=25),
                ) as resp:
                    if resp.status >= 400:
                        log.warning("GAS questionnaire HTTP %s", resp.status)
        except Exception as err:
            log.exception("GAS questionnaire failed: %s", err)
    else:
        await forward_client_message(
            update,
            context,
            "📝 Анкета:\n"
            f"Ограничения: {answers.get('restrictions', '—')}\n"
            f"Аллергии: {answers.get('allergies', '—')}\n"
            f"Пожелания: {answers.get('comment', '—')}",
        )
        ud(context).pop("mode", None)
        ud(context).pop("anketa", None)
        return

    ud(context).pop("mode", None)
    ud(context).pop("anketa", None)
    await reply_text(
        update.message,
        "Спасибо! Анкета принята ✅\n"
        "Мы свяжемся с вами в ближайшее время, чтобы подобрать варианты.",
        reply_markup=main_keyboard(),
    )


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message:
        return
    t = (update.message.text or "").strip()
    data = ud(context)
    mode = data.get("mode")

    if mode == "write_lena" and t not in MENU_BUTTONS:
        await forward_client_message(update, context, t)
        return

    if mode == "anketa_restrictions" and t not in MENU_BUTTONS:
        data.setdefault("anketa", {})["restrictions"] = t
        data["mode"] = "anketa_allergies"
        await reply_text(
            update.message,
            "Есть аллергии или продукты, которые точно не едите?",
            reply_markup=main_keyboard(),
        )
        return

    if mode == "anketa_allergies" and t not in MENU_BUTTONS:
        data.setdefault("anketa", {})["allergies"] = t
        data["mode"] = "anketa_comment"
        await reply_text(
            update.message,
            "Напишите свободно ваши пожелания (или «нет», если всё учли):",
            reply_markup=main_keyboard(),
        )
        return

    if mode == "anketa_comment" and t not in MENU_BUTTONS:
        data.setdefault("anketa", {})["comment"] = t
        await submit_questionnaire(update, context)
        return

    if t == "❓ Частые вопросы":
        data.pop("mode", None)
        await send_faq_menu(update)
    elif t == "📦 Мой заказ":
        data.pop("mode", None)
        await reply_text(
            update.message,
            "Оформите заказ в каталоге — после отправки придёт подтверждение с составом ✅\n\n"
            "Если заказ уже оформляли — Елена напишет статус сюда или уточните у неё: "
            f"{ELENA_USERNAME}",
            reply_markup=main_keyboard(),
        )
    elif t == "💬 Написать Елене":
        data["mode"] = "write_lena"
        await reply_text(
            update.message,
            f"Напишите ваш вопрос одним сообщением — передам Елене.\n\n"
            f"Или сразу в личку: {ELENA_USERNAME}",
            reply_markup=main_keyboard(),
        )
    elif t == "📝 Анкета":
        data["mode"] = "anketa_restrictions"
        data["anketa"] = {}
        await reply_text(
            update.message,
            "Анкета по ограничениям 📝\n\n"
            "Какие ограничения по продуктам? (без молока, без глютена, веган и т.д.)",
            reply_markup=main_keyboard(),
        )
    elif t not in MENU_BUTTONS:
        await reply_text(
            update.message,
            "Выберите кнопку ниже или «❓ Частые вопросы».\n"
            f"Чтобы написать Елене — «💬 Написать Елене».",
            reply_markup=main_keyboard(),
        )


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    try:
        await tg_retry(lambda: query.answer(), label="callback_answer", attempts=3)
    except (TimedOut, NetworkError) as err:
        log.warning("answer_callback_query failed: %s", err)
    data = query.data or ""

    if data.startswith("faq:"):
        key = data.split(":", 1)[1]
        text = FAQ_TEXT.get(key, "Выберите вопрос из меню.")
        await reply_text(query.message, text, reply_markup=main_keyboard())
        return

    if data == "menu:back":
        ud(context).pop("mode", None)
        await send_welcome(update)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
    log.exception("Handler error: %s", context.error)


async def post_init(application: Application):
    # Гарантированно снимаем чужой/старый webhook — иначе getUpdates падает с Conflict
    info = await tg_retry(lambda: application.bot.get_webhook_info(), label="get_webhook_info")
    if info.url:
        log.warning("Found active webhook %s — deleting for polling", info.url)
    await tg_retry(
        lambda: application.bot.delete_webhook(drop_pending_updates=False),
        label="delete_webhook",
    )
    await tg_retry(
        lambda: application.bot.set_my_commands(
            [
                BotCommand("start", "Главное меню"),
                BotCommand("catalog", "Открыть каталог"),
                BotCommand("faq", "Частые вопросы"),
                BotCommand("myid", "Узнать chat_id"),
            ]
        ),
        label="set_commands",
    )
    await tg_retry(
        lambda: application.bot.set_chat_menu_button(
            menu_button=MenuButtonWebApp(
                text="🍰 Каталог",
                web_app=WebAppInfo(url=MINI_APP_URL),
            )
        ),
        label="set_menu_button",
    )
    log.info(
        "Bot ready (POLLING), api_base=%s, LENA_CHAT_ID=%s",
        TELEGRAM_API_BASE,
        LENA_CHAT_ID,
    )


def start_health_server():
    """Amvera healthcheck на :80 — в отдельном потоке."""

    async def health(_request):
        return web.Response(text="ok")

    async def run():
        app = web.Application()
        app.router.add_get("/", health)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", PORT)
        await site.start()
        log.info("Health server on 0.0.0.0:%s", PORT)
        while True:
            await asyncio.sleep(3600)

    def thread_main():
        asyncio.run(run())

    t = threading.Thread(target=thread_main, name="health", daemon=True)
    t.start()


def build_application() -> Application:
    # Жёстче таймауты + отдельный пул для getUpdates, чтобы send не блокировался.
    proxy_headers = {}
    if TELEGRAM_PROXY_SECRET:
        proxy_headers["X-Tg-Proxy-Secret"] = TELEGRAM_PROXY_SECRET
    request = HTTPXRequest(
        connection_pool_size=16,
        connect_timeout=15.0,
        read_timeout=30.0,
        write_timeout=30.0,
        pool_timeout=15.0,
        httpx_kwargs={"headers": proxy_headers} if proxy_headers else None,
    )
    updates_request = HTTPXRequest(
        connection_pool_size=4,
        connect_timeout=15.0,
        read_timeout=20.0,
        write_timeout=20.0,
        pool_timeout=15.0,
        httpx_kwargs={"headers": proxy_headers} if proxy_headers else None,
    )
    application = (
        Application.builder()
        .token(BOT_TOKEN)
        .base_url(TELEGRAM_API_BASE)
        .request(request)
        .get_updates_request(updates_request)
        .post_init(post_init)
        .build()
    )
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("catalog", cmd_catalog))
    application.add_handler(CommandHandler("faq", cmd_faq))
    application.add_handler(CommandHandler("myid", cmd_myid))
    application.add_handler(CallbackQueryHandler(on_callback))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    application.add_error_handler(on_error)
    return application


def main():
    if not BOT_TOKEN:
        raise SystemExit("BOT_TOKEN not set")

    start_health_server()
    log.info("TELEGRAM_API_BASE=%s", TELEGRAM_API_BASE)

    # Несколько попыток старта (Amvera↔Telegram иногда таймаутит / чужой webhook)
    last_err = None
    for attempt in range(1, 8):
        try:
            app = build_application()
            log.info("Starting polling (attempt %s/8)...", attempt)
            app.run_polling(
                drop_pending_updates=False,
                # Короткий опрос: ответ обычно <2 сек после сообщения.
                poll_interval=0.0,
                timeout=1,
                allowed_updates=Update.ALL_TYPES,
                close_loop=False,
            )
            return
        except Conflict as err:
            last_err = err
            log.warning("Conflict (webhook active) %s/8: %s — clearing webhook", attempt, err)
            try:
                import httpx

                base = TELEGRAM_API_BASE.rstrip("/")
                httpx.post(f"{base}{BOT_TOKEN}/deleteWebhook", timeout=30)
            except Exception as clear_err:
                log.warning("deleteWebhook failed: %s", clear_err)
            import time

            time.sleep(2)
        except (TimedOut, NetworkError, OSError) as err:
            last_err = err
            log.warning("Polling start failed %s/8: %s", attempt, err)
            import time

            time.sleep(3 * attempt)
    raise SystemExit(f"Failed to start bot: {last_err}")


if __name__ == "__main__":
    main()
