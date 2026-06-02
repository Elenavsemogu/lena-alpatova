/**
 * PP Фея — приём заявок с сайта → Telegram + Google Sheets
 *
 * Настройка через Script Properties (Project Settings → Script Properties):
 * - BOT_TOKEN:   уже вписан ниже как HARDCODED_BOT_TOKEN, но лучше хранить в Properties
 * - LENA_CHAT_ID: chat_id Лены (число) — узнаём в шаг 2 инструкции
 * - SHEET_ID:     id Google Spreadsheet — из URL таблицы
 * - SHEET_ORDERS: "Orders"
 * - SHEET_FORMS:  "Forms"
 *
 * Бот: @pp_fairy_bot  id: 8708408440
 */

// Токен уже прописан здесь как запасной вариант (если нет Script Property BOT_TOKEN)
var HARDCODED_BOT_TOKEN = "8708408440:AAHVJZOI4dAKShpcMX-oqJ8aY2R6GZvdrB8";

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    var type = payload.type || "order";

    if (type === "order") return handleOrder_(payload);
    if (type === "questionnaire") return handleQuestionnaire_(payload);

    return json_(200, { ok: true, ignored: true, type: type });
  } catch (err) {
    return json_(200, { ok: false, error: String(err) });
  }
}

function handleOrder_(p) {
  var props = PropertiesService.getScriptProperties();
  var botToken = props.getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
  var lenaChatId = props.getProperty("LENA_CHAT_ID");
  var sheetId = props.getProperty("SHEET_ID");
  var sheetName = props.getProperty("SHEET_ORDERS") || "Orders";

  var ts = new Date();
  var source = p.source || "web";
  var client = p.client || {};
  var items = p.items || [];
  var totals = p.totals || {};

  if (sheetId) {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    ensureOrdersHeader_(sh);
    sh.appendRow([
      ts,
      source,
      client.tgUserId || "",
      client.username || "",
      client.firstName || "",
      client.lastName || "",
      client.phone || "",
      client.comment || "",
      items.map(function (it) { return it.name + " (" + it.variant + ") × " + it.qty; }).join("\n"),
      totals.price || "",
      totals.kcal || "",
      totals.p || "",
      totals.f || "",
      totals.c || ""
    ]);
  }

  var lenaText = formatOrderForLena_(ts, source, client, items, totals);
  if (botToken && lenaChatId) {
    tgSend_(botToken, lenaChatId, lenaText, { parse_mode: "HTML", disable_web_page_preview: true });
  }

  // Ответ клиенту возможен только если заказ пришёл из TG Mini App (есть tgUserId).
  var clientId = client.tgUserId;
  if (botToken && clientId) {
    var clientText = formatOrderForClient_(items, totals);
    tgSend_(botToken, String(clientId), clientText, { disable_web_page_preview: true });
  }

  return json_(200, { ok: true });
}

function handleQuestionnaire_(p) {
  var props = PropertiesService.getScriptProperties();
  var botToken = props.getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
  var lenaChatId = props.getProperty("LENA_CHAT_ID");
  var sheetId = props.getProperty("SHEET_ID");
  var sheetName = props.getProperty("SHEET_FORMS") || "Forms";

  var ts = new Date();
  var source = p.source || "web";
  var client = p.client || {};
  var a = p.answers || {};

  if (sheetId) {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
    ensureFormsHeader_(sh);
    sh.appendRow([
      ts,
      source,
      client.tgUserId || "",
      client.username || "",
      client.firstName || "",
      client.lastName || "",
      client.phone || "",
      a.goal || "",
      (a.restrictions || []).join(", "),
      a.allergies || "",
      a.likes || "",
      a.dislikes || "",
      a.kbzhuImportance || "",
      a.kbzhuTarget || "",
      a.when || "",
      a.delivery || "",
      a.address || "",
      a.comment || ""
    ]);
  }

  var lenaText = formatFormForLena_(ts, source, client, a);
  if (botToken && lenaChatId) {
    tgSend_(botToken, lenaChatId, lenaText, { parse_mode: "HTML", disable_web_page_preview: true });
  }

  var clientId = client.tgUserId;
  if (botToken && clientId) {
    tgSend_(botToken, String(clientId), "Спасибо! Анкета принята ✅\nМы свяжемся с вами в ближайшее время, чтобы подобрать варианты.", {});
  }

  return json_(200, { ok: true });
}

function ensureOrdersHeader_(sh) {
  if (sh.getLastRow() > 0) return;
  sh.appendRow([
    "created_at",
    "source",
    "tg_user_id",
    "username",
    "first_name",
    "last_name",
    "phone",
    "comment",
    "items",
    "total_price",
    "total_kcal",
    "total_p",
    "total_f",
    "total_c"
  ]);
}

function ensureFormsHeader_(sh) {
  if (sh.getLastRow() > 0) return;
  sh.appendRow([
    "created_at",
    "source",
    "tg_user_id",
    "username",
    "first_name",
    "last_name",
    "phone",
    "goal",
    "restrictions",
    "allergies",
    "likes",
    "dislikes",
    "kbzhu_importance",
    "kbzhu_target",
    "when",
    "delivery",
    "address",
    "comment"
  ]);
}

function formatOrderForClient_(items, totals) {
  var lines = [];
  lines.push("Спасибо! Мы увидели ваш заказ и уже взяли в работу ✅");
  lines.push("");
  lines.push("Свяжемся с вами в течение 10 минут, чтобы согласовать детали.");
  lines.push("");
  lines.push("В вашем заказе:");
  items.forEach(function (it) {
    lines.push("— " + it.name + " (" + it.variant + ") × " + it.qty);
  });
  lines.push("");
  lines.push("Сумма: " + (totals.price || 0) + " ₽");
  return lines.join("\n");
}

function formatOrderForLena_(ts, source, client, items, totals) {
  var lines = [];
  lines.push("📦 <b>Новый заказ с сайта</b>");
  lines.push("");
  lines.push("Источник: <b>" + esc_(source) + "</b>");
  lines.push("Время: " + esc_(Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")));
  lines.push("");
  lines.push("Клиент: " + esc_((client.firstName || "") + " " + (client.lastName || "")).trim() + (client.username ? " (@" + esc_(client.username) + ")" : ""));
  if (client.phone) lines.push("Телефон: " + esc_(client.phone));
  if (client.comment) lines.push("Комментарий: " + esc_(client.comment));
  lines.push("");
  lines.push("<b>Состав заказа:</b>");
  items.forEach(function (it) {
    lines.push("• " + esc_(it.name) + " (" + esc_(it.variant) + ") × " + esc_(String(it.qty)) + " = " + esc_(String(it.sum || "")) + " ₽");
  });
  lines.push("");
  lines.push("<b>Итого:</b> " + esc_(String(totals.price || 0)) + " ₽");
  if (totals.kcal != null) lines.push("КБЖУ: " + esc_(String(totals.kcal)) + " ккал · Б " + esc_(String(totals.p)) + " · Ж " + esc_(String(totals.f)) + " · У " + esc_(String(totals.c)));
  return lines.join("\n");
}

function formatFormForLena_(ts, source, client, a) {
  var lines = [];
  lines.push("📝 <b>Анкета (ограничения и пожелания)</b>");
  lines.push("");
  lines.push("Источник: <b>" + esc_(source) + "</b>");
  lines.push("Время: " + esc_(Utilities.formatDate(ts, Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss")));
  lines.push("");
  lines.push("Клиент: " + esc_((client.firstName || "") + " " + (client.lastName || "")).trim() + (client.username ? " (@" + esc_(client.username) + ")" : ""));
  if (client.phone) lines.push("Телефон: " + esc_(client.phone));
  lines.push("");
  lines.push("<b>Цель/повод:</b> " + esc_(a.goal || ""));
  lines.push("<b>Ограничения:</b> " + esc_((a.restrictions || []).join(", ")));
  if (a.allergies) lines.push("<b>Аллергии:</b> " + esc_(a.allergies));
  if (a.likes) lines.push("<b>Люблю:</b> " + esc_(a.likes));
  if (a.dislikes) lines.push("<b>Не люблю/нельзя:</b> " + esc_(a.dislikes));
  lines.push("<b>КБЖУ важно:</b> " + esc_(a.kbzhuImportance || ""));
  if (a.kbzhuTarget) lines.push("<b>Цель по ккал/БЖУ:</b> " + esc_(a.kbzhuTarget));
  lines.push("<b>Когда нужно:</b> " + esc_(a.when || ""));
  lines.push("<b>Доставка:</b> " + esc_(a.delivery || ""));
  if (a.address) lines.push("<b>Адрес:</b> " + esc_(a.address));
  if (a.comment) lines.push("<b>Комментарий:</b> " + esc_(a.comment));
  return lines.join("\n");
}

function tgSend_(token, chatId, text, opts) {
  var url = "https://api.telegram.org/bot" + token + "/sendMessage";
  var payload = Object.assign({ chat_id: chatId, text: text }, (opts || {}));
  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

function json_(code, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Запусти эту функцию вручную (Run → getMyLenaChatId) ПОСЛЕ того как напишешь /start боту.
 * Она напечатает твой chat_id в логах (View → Logs).
 */
function getMyLenaChatId() {
  var token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
  var resp = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getUpdates", { muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText());
  var result = data.result || [];
  if (!result.length) {
    Logger.log("Нет обновлений. Сначала напиши /start боту @pp_fairy_bot, потом запусти эту функцию снова.");
    return;
  }
  result.forEach(function (upd) {
    var msg = upd.message || upd.edited_message;
    if (msg) Logger.log("chat_id: " + msg.chat.id + "  username: " + (msg.chat.username || "") + "  first_name: " + (msg.chat.first_name || ""));
  });
}

/**
 * Используй, чтобы проверить, что бот шлёт сообщение тебе.
 * Сначала заполни Script Property LENA_CHAT_ID (или вставь напрямую ниже),
 * потом Run → testSendToLena.
 */
function testSendToLena() {
  var token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
  var chatId = PropertiesService.getScriptProperties().getProperty("LENA_CHAT_ID");
  if (!chatId) { Logger.log("LENA_CHAT_ID не задан в Script Properties"); return; }
  tgSend_(token, chatId, "✅ Тест пройден! Сайт ПП Феи успешно связан с ботом.", {});
  Logger.log("Сообщение отправлено на " + chatId);
}

function esc_(s) {
  return String(s || "").replace(/[&<>]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
  });
}

