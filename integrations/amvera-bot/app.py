"""
@pp_fairy_bot — webhook на Amvera (мгновенные ответы).
Переменные окружения в панели Amvera → Переменные:
  BOT_TOKEN, LENA_CHAT_ID, GAS_WEBHOOK_URL (URL Apps Script для заказов с сайта)
  WEBHOOK_URL (https://ваш-проект.amvera.io — без слэша в конце)
"""
import os
import json
import logging
from aiohttp import web
from telegram import Update, WebAppInfo, KeyboardButton, ReplyKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
LENA_CHAT_ID = os.environ.get("LENA_CHAT_ID", "6336708488")
GAS_WEBHOOK_URL = os.environ.get("GAS_WEBHOOK_URL", "")
MINI_APP_URL = os.environ.get("MINI_APP_URL", "https://xn--e1atau0d.xn--p1ai/")
WEBHOOK_PATH = os.environ.get("WEBHOOK_PATH", "/webhook")
PORT = int(os.environ.get("PORT", "80"))

application = None


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


async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = (update.message.text or "").strip()
    parts = text.split()
    if len(parts) > 1 and parts[1].startswith("order_"):
        order_id = parts[1].replace("order_", "", 1)
        await update.message.reply_text(
            f"Ваш заказ уже принят на сайте ✅\nНомер: {order_id}\n\n"
            "Если нужно что-то изменить — напишите Елене: @elenappdeserty",
            reply_markup=main_keyboard(),
        )
        return
    await update.message.reply_text(
        "Здравствуйте! Я помощник Елены — «ПП Фея» 🧁\n\n"
        "Нажмите «🍰 Открыть каталог» — заказ прямо в Telegram.",
        reply_markup=main_keyboard(),
    )


async def cmd_myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cid = update.effective_chat.id
    await update.message.reply_text(f"Ваш chat_id: {cid}", reply_markup=main_keyboard())


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    t = (update.message.text or "").strip()
    if t == "❓ Частые вопросы":
        await update.message.reply_text(
            "Частые вопросы — на сайте ппфея.рф в разделе FAQ или напишите @elenappdeserty",
            reply_markup=main_keyboard(),
        )
    elif t == "📦 Мой заказ":
        await update.message.reply_text(
            "Оформите заказ в каталоге — подтверждение придёт сюда, если заказывали из Mini App.",
            reply_markup=main_keyboard(),
        )
    elif t in ("💬 Написать Елене", "📝 Анкета"):
        await update.message.reply_text("Напишите Елене: @elenappdeserty", reply_markup=main_keyboard())


async def health(_request):
    return web.Response(text="ok")


async def telegram_webhook(request):
    global application
    if not application:
        return web.Response(status=503)
    data = await request.json()
    update = Update.de_json(data, application.bot)
    await application.process_update(update)
    return web.Response(text="ok")


async def on_startup(app: web.Application):
    global application
    if not BOT_TOKEN:
        log.error("BOT_TOKEN not set")
        return
    application = (
        Application.builder().token(BOT_TOKEN).build()
    )
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("myid", cmd_myid))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    await application.initialize()
    await application.start()
    webhook_url = os.environ.get("WEBHOOK_URL", "").rstrip("/")
    if webhook_url:
        full = f"{webhook_url}{WEBHOOK_PATH}"
        await application.bot.set_webhook(url=full, drop_pending_updates=True)
        log.info("Webhook set: %s", full)
    log.info("Bot started, LENA_CHAT_ID=%s", LENA_CHAT_ID)


async def on_shutdown(app: web.Application):
    global application
    if application:
        await application.stop()
        await application.shutdown()


def create_app():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_post(WEBHOOK_PATH, telegram_webhook)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="0.0.0.0", port=PORT)
