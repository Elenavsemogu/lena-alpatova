/**
 * PP Фея — приём заявок с сайта → Telegram + Google Sheets
 *
 * Script Properties (обязательно):
 * - BOT_TOKEN       — только здесь, НЕ в коде / git
 * - WEBHOOK_SECRET  — ключ сайта/бота (см. index.html ORDER_WEBHOOK_SECRET)
 * - LENA_CHAT_ID, SHEET_ID, SHEET_ORDERS, SHEET_FORMS
 *
 * Бот: @pp_fairy_bot (polling на Amvera; GAS — заказы/анкеты)
 */

var HARDCODED_SHEET_ID = "1d4vyOwUcHbAYS9mFc0oUWjbghYqcDrlQ8xS23m8E1to";
var HARDCODED_LENA_CHAT_ID = "6336708488";
var DEFAULT_MINI_APP_URL = "https://xn--e1atau0d.xn--p1ai/";
// Совпадает с ORDER_WEBHOOK_SECRET на сайте; лучше дублировать в Script Properties
var DEFAULT_WEBHOOK_SECRET = "LM7PuTO-xx2Syq5ooL-8QkhmpJ4jHZun37ilplN6uwk";

function getBotToken_() {
  return PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || "";
}

function getWebhookSecret_() {
  return (
    PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET") ||
    DEFAULT_WEBHOOK_SECRET ||
    ""
  );
}

function getLenaChatId_() {
  return PropertiesService.getScriptProperties().getProperty("LENA_CHAT_ID") || HARDCODED_LENA_CHAT_ID;
}

function getSheetId_() {
  return PropertiesService.getScriptProperties().getProperty("SHEET_ID") || HARDCODED_SHEET_ID;
}

/** Ключ из query / form / JSON. */
function extractWebhookKey_(e, payload) {
  var key = "";
  if (e && e.parameter) {
    key = String(e.parameter.key || e.parameter.secret || e.parameter.webhook_secret || "");
  }
  if (!key && payload && typeof payload === "object") {
    key = String(payload.key || payload.secret || payload.webhook_secret || "");
  }
  return key;
}

function isWebhookAuthorized_(e, payload) {
  var expected = getWebhookSecret_();
  if (!expected) return true;
  return extractWebhookKey_(e, payload) === expected;
}

/** Глобальный антиспам (CacheService). */
function rateLimitOk_(bucket, limit, ttlSec) {
  var cache = CacheService.getScriptCache();
  var k = "rl_" + bucket;
  var n = parseInt(cache.get(k) || "0", 10);
  if (isNaN(n)) n = 0;
  if (n >= limit) return false;
  cache.put(k, String(n + 1), ttlSec || 3600);
  return true;
}

function getMiniAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty("MINI_APP_URL") || DEFAULT_MINI_APP_URL;
}

function normalizeOrderId_(orderId) {
  var id = String(orderId || "").trim();
  while (id.indexOf("order_") === 0) id = id.slice("order_".length);
  while (id.indexOf("ord_") === 0) id = id.slice("ord_".length);
  if (/^\d+$/.test(id)) {
    var n = parseInt(id, 10);
    if (!isNaN(n) && n >= 0) return Utilities.formatString("%03d", n % 1000);
  }
  return id;
}

/** Максимальный 3-значный номер заказа за сегодня (из таблицы). */
function getMaxOrderNumToday_() {
  var sheetId = getSheetId_();
  if (!sheetId) return 100;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(PropertiesService.getScriptProperties().getProperty("SHEET_ORDERS") || "Orders");
  if (!sh || sh.getLastRow() < 2) return 100;

  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h || "").trim()] = i; });
  if (idx.order_id == null || idx.created_at == null) return 100;

  var values = sh.getRange(2, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var maxNum = 100;
  for (var r = 0; r < values.length; r++) {
    var created = values[r][idx.created_at];
    if (!created) continue;
    var rowDate = Utilities.formatDate(new Date(created), tz, "yyyy-MM-dd");
    if (rowDate !== today) continue;
    var n = parseInt(normalizeOrderId_(values[r][idx.order_id]), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }
  return maxNum;
}

function orderIdExists_(orderId) {
  orderId = normalizeOrderId_(orderId);
  if (!orderId) return false;
  var sheetId = getSheetId_();
  if (!sheetId) return false;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(PropertiesService.getScriptProperties().getProperty("SHEET_ORDERS") || "Orders");
  if (!sh || sh.getLastRow() < 2) return false;

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h || "").trim()] = i; });
  if (idx.order_id == null) return false;

  var values = sh.getRange(2, idx.order_id + 1, sh.getLastRow(), 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (normalizeOrderId_(values[r][0]) === orderId) return true;
  }
  return false;
}

/** Выдать следующий номер заказа за сегодня: 101 … 999 (с резервом в cache). */
function allocateNextOrderId_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    var props = PropertiesService.getScriptProperties();
    var cache = CacheService.getScriptCache();
    var tz = Session.getScriptTimeZone();
    var today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    var dayKey = "order_seq_" + today;
    var sheetMax = getMaxOrderNumToday_();
    var seq = parseInt(cache.get(dayKey) || props.getProperty(dayKey) || String(sheetMax), 10);
    if (isNaN(seq) || seq < 100) seq = Math.max(100, sheetMax);
    var next = seq + 1;
    if (next > 999) next = 101;
    var id = Utilities.formatString("%03d", next);
    cache.put(dayKey, String(next), 21600);
    props.setProperty(dayKey, String(next));
    return id;
  } finally {
    lock.releaseLock();
  }
}

function getNextOrderId_() {
  return allocateNextOrderId_();
}

function saveOrderDraftCache_(orderId, payload) {
  var json = JSON.stringify(payload);
  try {
    CacheService.getScriptCache().put("order:" + orderId, json, 21600);
  } catch (_) {}
  try {
    PropertiesService.getScriptProperties().setProperty("draft:" + orderId, json);
  } catch (_) {}
}

function loadOrderDraftCache_(orderId) {
  orderId = normalizeOrderId_(orderId);
  try {
    var raw = CacheService.getScriptCache().get("order:" + orderId);
    if (!raw) raw = PropertiesService.getScriptProperties().getProperty("draft:" + orderId);
    if (!raw) return null;
    var p = JSON.parse(raw);
    return {
      orderId: p.orderId || orderId,
      items: p.items || [],
      totals: p.totals || {},
      client: p.client || {},
      source: p.source || "web",
      status: p.status || "",
      lenaNotified: !!p.lenaNotified,
      clientNotified: !!p.clientNotified,
      processed: !!p.processed
    };
  } catch (_) {
    return null;
  }
}

// Telegram при setWebhook / проверках может обращаться GET-запросом.
// Чтобы не получать 405 Method Not Allowed — отвечаем 200 OK.
function parseIncomingPayload_(e) {
  if (!e) return {};
  if (e.postData && e.postData.contents) {
    try { return JSON.parse(e.postData.contents); } catch (_) {}
  }
  var p = e.parameter || {};
  if (p.data) {
    try { return JSON.parse(String(p.data)); } catch (_) {}
  }
  if (p.payload) {
    try { return JSON.parse(String(p.payload)); } catch (_) {}
  }
  return {};
}

function doGet(e) {
  var payload = parseIncomingPayload_(e);
  var action = e && e.parameter ? String(e.parameter.action || "") : "";
  var needsAuth =
    action === "allocate_order" ||
    action === "order_lookup" ||
    (payload && payload.type === "order_draft") ||
    (e && e.parameter && e.parameter.type === "order_draft");

  if (needsAuth && !isWebhookAuthorized_(e, payload)) {
    return json_(403, { ok: false, error: "unauthorized" });
  }

  if (payload && payload.type === "order_draft") {
    if (!rateLimitOk_("order_hour", 40, 3600)) {
      return json_(429, { ok: false, error: "rate_limited" });
    }
    return handleOrderDraft_(payload);
  }
  if (action === "order_lookup") {
    if (!rateLimitOk_("lookup_hour", 120, 3600)) {
      return json_(429, { ok: false, error: "rate_limited" });
    }
    var orderId = normalizeOrderId_(e.parameter.orderId || "");
    var order = findOrderById_(orderId);
    if (!order) return json_(200, { ok: false, error: "not_found" });
    return json_(200, { ok: true, order: order });
  }
  if (action === "allocate_order") {
    if (!rateLimitOk_("alloc_hour", 40, 3600)) {
      var cbDeny = String((e.parameter && e.parameter.callback) || "");
      var deny = JSON.stringify({ ok: false, error: "rate_limited" });
      if (cbDeny && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(cbDeny)) {
        return ContentService
          .createTextOutput(cbDeny + "(" + deny + ");")
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return json_(429, { ok: false, error: "rate_limited" });
    }
    var newId = allocateNextOrderId_();
    var cb = String(e.parameter.callback || "");
    if (cb && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(cb)) {
      return ContentService
        .createTextOutput(cb + "(" + JSON.stringify({ ok: true, orderId: newId }) + ");")
        .setMimeType(ContentService.MimeType.JAVASCRIPT);
    }
    return json_(200, { ok: true, orderId: newId });
  }
  if (e && e.parameter && e.parameter.type === "order_draft" && e.parameter.data) {
    try {
      payload = JSON.parse(String(e.parameter.data));
      if (!rateLimitOk_("order_hour", 40, 3600)) {
        return json_(429, { ok: false, error: "rate_limited" });
      }
      return handleOrderDraft_(payload);
    } catch (err) {
      return json_(200, { ok: false, error: String(err) });
    }
  }
  return json_(200, { ok: true, ts: new Date().toISOString() });
}

function doPost(e) {
  try {
    var payload = parseIncomingPayload_(e);
    if (!payload || !Object.keys(payload).length) {
      payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    }

    // Старый TG webhook на GAS больше не используем — без ключа отклоняем
    if (payload && payload.update_id) {
      return json_(403, { ok: false, error: "telegram_webhook_disabled" });
    }

    if (!isWebhookAuthorized_(e, payload)) {
      return json_(403, { ok: false, error: "unauthorized" });
    }

    var type = payload.type || "order";

    if (type === "order" || type === "order_draft" || type === "questionnaire") {
      if (!rateLimitOk_("post_hour", 50, 3600)) {
        return json_(429, { ok: false, error: "rate_limited" });
      }
    }

    if (type === "order") return handleOrder_(payload);
    if (type === "order_draft") return handleOrderDraft_(payload);
    if (type === "questionnaire") return handleQuestionnaire_(payload);

    return json_(200, { ok: true, ignored: true, type: type });
  } catch (err) {
    return json_(200, { ok: false, error: String(err) });
  }
}

/**
 * Заказ с сайта / Mini App: таблица + одно уведомление Лене + (опционально) одно сообщение клиенту в TG.
 */
function handleOrderDraft_(p) {
  var ts = new Date();
  var rawId = normalizeOrderId_(p.orderId || "");
  var orderId;
  if (/^\d{3}$/.test(rawId) && !orderIdExists_(rawId)) {
    orderId = rawId;
  } else {
    orderId = allocateNextOrderId_();
  }
  var source = p.source || "web";
  var client = p.client || {};
  var items = p.items || [];
  var totals = p.totals || {};

  var existing = loadOrderDraftCache_(orderId);
  if (existing && existing.processed) {
    return json_(200, { ok: true, orderId: orderId, duplicate: true });
  }

  appendOrderRow_(ts, source, client, items, totals, orderId, "ACCEPTED");
  processSiteOrderNotifications_(orderId, ts, source, client, items, totals);

  return json_(200, { ok: true, orderId: orderId });
}

function appendOrderRow_(ts, source, client, items, totals, orderId, status) {
  var sheetId = getSheetId_();
  var sheetName = PropertiesService.getScriptProperties().getProperty("SHEET_ORDERS") || "Orders";
  if (!sheetId) return;
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
    totals.c || "",
    orderId,
    status || "ACCEPTED"
  ]);
}

/** Одно сообщение Лене; одно клиенту — только если заказ из Mini App (есть tgUserId). */
function processSiteOrderNotifications_(orderId, ts, source, client, items, totals) {
  var cached = loadOrderDraftCache_(orderId) || {};
  var lenaNotified = !!cached.lenaNotified;
  var clientNotified = !!cached.clientNotified;
  var botToken = getBotToken_();
  var lenaChatId = getLenaChatId_();
  var clientId = client.tgUserId ? String(client.tgUserId) : "";

  if (!lenaNotified && botToken && lenaChatId) {
    var lenaText = formatOrderForLena_(ts, source, client, items, totals);
    lenaText += "\n\n<b>Номер заказа:</b> " + esc_(String(orderId));
    tgSend_(botToken, lenaChatId, lenaText, { parse_mode: "HTML", disable_web_page_preview: true });
    lenaNotified = true;
  }

  if (!clientNotified && clientId && botToken) {
    tgSend_(botToken, clientId, formatOrderAcceptedForClient_(orderId, items, totals, client.phone), { disable_web_page_preview: true });
    clientNotified = true;
  }

  saveOrderDraftCache_(orderId, {
    orderId: orderId,
    source: source,
    client: client,
    items: items,
    totals: totals,
    ts: ts,
    status: "ACCEPTED",
    lenaNotified: lenaNotified,
    clientNotified: clientNotified,
    processed: true
  });
}

function handleOrder_(p) {
  var props = PropertiesService.getScriptProperties();
  var botToken = getBotToken_();
  var lenaChatId = getLenaChatId_();
  var sheetId = getSheetId_();
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
  var botToken = getBotToken_();
  var lenaChatId = getLenaChatId_();
  var sheetId = getSheetId_();
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
  var header = [
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
    "total_c",
    "order_id",
    "status"
  ];

  var lastRow = sh.getLastRow();
  if (lastRow === 0) {
    sh.appendRow(header);
    return;
  }

  // Если заголовок уже есть, но без новых колонок — добавим их в первую строку.
  var firstRow = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var existing = {};
  firstRow.forEach(function (v) { existing[String(v || "").trim()] = true; });
  var missing = header.filter(function (h) { return !existing[h]; });
  if (!missing.length) return;

  var startCol = sh.getLastColumn() + 1;
  sh.getRange(1, startCol, 1, missing.length).setValues([missing]);
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
  return formatOrderAcceptedForClient_("", items, totals, "");
}

function formatOrderAcceptedForClient_(orderId, items, totals, phone) {
  var lines = [];
  lines.push("Спасибо! Ваш заказ принят и уже в обработке ✅");
  if (orderId) lines.push("Номер заказа: " + orderId);
  lines.push("");
  lines.push("В вашем заказе:");
  (items || []).forEach(function (it) {
    lines.push("— " + it.name + " (" + it.variant + ") × " + it.qty);
  });
  lines.push("");
  lines.push("Сумма: " + (totals.price || 0) + " ₽");
  lines.push("");
  if (phone) {
    lines.push("Свяжемся с вами скоро по телефону " + phone + ", чтобы согласовать детали.");
  } else {
    lines.push("Свяжемся с вами скоро, чтобы согласовать детали.");
  }
  return lines.join("\n");
}

function formatOrderStatusInBot_(order) {
  var lines = [];
  lines.push("Ваш заказ уже принят на сайте ✅");
  if (order.orderId) lines.push("Номер: " + order.orderId);
  lines.push("");
  lines.push("Позиции:");
  (order.items || []).forEach(function (it) {
    lines.push("— " + it.name + (it.variant ? " (" + it.variant + ")" : "") + " × " + it.qty);
  });
  lines.push("");
  lines.push("Сумма: " + (order.totals && order.totals.price ? order.totals.price : 0) + " ₽");
  lines.push("");
  lines.push("Если нужно что-то изменить — напишите Елене.");
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

function tgCall_(token, method, payload) {
  var url = "https://api.telegram.org/bot" + token + "/" + method;
  var res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true
  });
  try { return JSON.parse(res.getContentText()); } catch (_) { return { ok: false, raw: res.getContentText() }; }
}

function logTelegramContact_(msg) {
  if (!msg || !msg.from || !msg.chat) return;
  try {
    var sheetId = getSheetId_();
    if (!sheetId) return;
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName("Chats") || ss.insertSheet("Chats");
    if (sh.getLastRow() === 0) {
      sh.appendRow(["created_at", "chat_id", "username", "first_name", "last_name", "text"]);
    }
    sh.appendRow([
      new Date(),
      msg.chat.id,
      msg.from.username || "",
      msg.from.first_name || "",
      msg.from.last_name || "",
      String(msg.text || "").slice(0, 200)
    ]);

    var lenaUser = PropertiesService.getScriptProperties().getProperty("LENA_USERNAME");
    if (lenaUser && msg.from.username &&
        String(msg.from.username).toLowerCase() === String(lenaUser).toLowerCase()) {
      PropertiesService.getScriptProperties().setProperty("LENA_CHAT_ID", String(msg.chat.id));
    }
  } catch (_) {}
}

function handleTelegramUpdate_(u) {
  var props = PropertiesService.getScriptProperties();
  var botToken = getBotToken_();
  var chatId = u.message && u.message.chat ? u.message.chat.id : (u.callback_query && u.callback_query.message ? u.callback_query.message.chat.id : null);

  if (u.message) logTelegramContact_(u.message);

  if (u.message && u.message.text) {
    var text = String(u.message.text || "").trim();

    if (text.indexOf("/start") === 0 || text === "/catalog") {
      var parts = text.split(/\s+/);
      var param = parts.length > 1 ? parts[1] : "";
      if (param && param.indexOf("order_") === 0) {
        return tgStartOrder_(botToken, chatId, param.replace(/^order_/, ""));
      }
      tgSendWelcome_(botToken, chatId);
      return json_(200, { ok: true });
    }
    if (text === "/faq") {
      tgSendFaqMenu_(botToken, chatId);
      return json_(200, { ok: true });
    }
    if (text === "/myid") {
      tgSend_(botToken, String(chatId), "Ваш chat_id: " + chatId + "\n\nЕсли вы Лена — отправьте это число Елене, она внесёт его в настройки бота.", { reply_markup: getMainReplyKeyboard_() });
      return json_(200, { ok: true });
    }

    if (text === "❓ Частые вопросы") {
      tgSendFaqMenu_(botToken, chatId);
      return json_(200, { ok: true });
    }
    if (text === "📦 Мой заказ") {
      tgSend_(botToken, String(chatId), "Оформите заказ в каталоге — после отправки я покажу состав и кнопку «Подтвердить» ✅", { reply_markup: getMainReplyKeyboard_() });
      return json_(200, { ok: true });
    }
    if (text === "💬 Написать Елене") {
      tgSend_(botToken, String(chatId), "Напишите Елене: @elenappdeserty\nИли откройте каталог и оформите заказ через кнопку ниже 👇", { reply_markup: getMainReplyKeyboard_() });
      return json_(200, { ok: true });
    }
    if (text === "📝 Анкета") {
      tgSend_(botToken, String(chatId), "Анкета по ограничениям скоро будет в боте.\nПока напишите пожелания Елене: @elenappdeserty", { reply_markup: getMainReplyKeyboard_() });
      return json_(200, { ok: true });
    }
  }

  if (u.callback_query && u.callback_query.data) {
    return tgHandleCallback_(botToken, u.callback_query);
  }

  return json_(200, { ok: true });
}

function getMainReplyKeyboard_() {
  var url = getMiniAppUrl_();
  return {
    keyboard: [
      [{ text: "🍰 Открыть каталог и заказать", web_app: { url: url } }],
      [{ text: "❓ Частые вопросы" }, { text: "📦 Мой заказ" }],
      [{ text: "💬 Написать Елене" }, { text: "📝 Анкета" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

function tgSendWelcome_(token, chatId) {
  var lines = [];
  lines.push("Здравствуйте! Я помощник Елены — «ПП Фея» 🧁");
  lines.push("");
  lines.push("Торты, десерты, конфеты и выпечка из натуральных ингредиентов.");
  lines.push("Без сахара · Без белой муки · Барнаул");
  lines.push("");
  lines.push("Нажмите «🍰 Открыть каталог и заказать» — это сайт прямо в Telegram.");
  tgCall_(token, "sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    reply_markup: getMainReplyKeyboard_()
  });
}

function tgSendFaqMenu_(token, chatId) {
  var kb = {
    inline_keyboard: [
      [{ text: "Из чего готовите?", callback_data: "faq:ingredients" }],
      [{ text: "Как оплатить?", callback_data: "faq:pay" }],
      [{ text: "Доставка и самовывоз", callback_data: "faq:delivery" }],
      [{ text: "Можно на сегодня?", callback_data: "faq:today" }],
      [{ text: "Для диабетиков", callback_data: "faq:diabetes" }],
      [{ text: "Без молока / глютена", callback_data: "faq:allergy" }],
      [{ text: "← Назад", callback_data: "menu:back" }]
    ]
  };
  tgCall_(token, "sendMessage", { chat_id: chatId, text: "Частые вопросы — выберите тему:", reply_markup: kb });
}

function getFaqText_(key) {
  var map = {
    ingredients: "Только натуральные ингредиенты:\n\n🌾 Мука: бурого риса, полбяная, овсяная, цельнозерновая\n🍯 Вместо сахара: эритритол (ГИ = 0)\n🍫 Шоколад без сахара\n🍞 Хлеб на закваске\n\nБез добавок и усилителей вкуса.",
    pay: "💳 Оплата:\n\n• Предоплата 1 000–2 000 ₽ при оформлении\n• Перевод на карту (реквизиты пришлём после заказа)\n• Остаток — при получении",
    delivery: "🚚 Доставка по Барнаулу: 300–500 ₽, время по договорённости.\n\n📍 Самовывоз: Павловский тракт 229",
    today: "⏰ Часто можем приготовить и привезти уже сегодня — зависит от загрузки. Чем раньше закажете, тем больше вариантов!",
    diabetes: "✅ Да! Эритритол (ГИ = 0) вместо сахара, мука с низким ГИ.",
    allergy: "✅ Делаем без молока (веган) и без глютена — уточните при заказе в комментарии."
  };
  return map[key] || "Выберите вопрос из меню.";
}

function setupBotUi() {
  var token = getBotToken_();
  var url = getMiniAppUrl_();
  tgCall_(token, "setChatMenuButton", {
    menu_button: { type: "web_app", text: "🍰 Каталог", web_app: { url: url } }
  });
  tgCall_(token, "setMyCommands", {
    commands: [
      { command: "start", description: "Главное меню" },
      { command: "catalog", description: "Открыть каталог" },
      { command: "faq", description: "Частые вопросы" },
      { command: "myid", description: "Узнать свой chat_id" }
    ]
  });
}

/** Run → listChatsFromSheet — последние, кто писал боту (лист Chats в таблице). */
function listChatsFromSheet() {
  getMyLenaChatId();
}

function tgStartOrder_(token, chatId, orderId) {
  orderId = normalizeOrderId_(orderId);
  var order = findOrderById_(orderId);
  if (!order) {
    tgSend_(token, String(chatId), "Не нашла заказ. Возможно, ссылка устарела. Попробуйте оформить заказ ещё раз на сайте.", { reply_markup: getMainReplyKeyboard_() });
    return json_(200, { ok: true });
  }

  order.orderId = order.orderId || orderId;
  // Заказ уже принят на сайте — только статус, без повторного подтверждения и без второго сообщения Лене.
  var txt = formatOrderStatusInBot_(order);
  tgCall_(token, "sendMessage", { chat_id: chatId, text: txt, reply_markup: getMainReplyKeyboard_() });
  return json_(200, { ok: true });
}

function tgHandleCallback_(token, cq) {
  var data = String(cq.data || "");
  var chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;

  if (data.indexOf("confirm:") === 0) {
    var orderId = normalizeOrderId_(data.replace(/^confirm:/, ""));
    var order = findOrderById_(orderId);
    tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "Заказ уже принят ✅" });
    if (order) {
      tgCall_(token, "sendMessage", { chat_id: chatId, text: formatOrderStatusInBot_(order), reply_markup: getMainReplyKeyboard_() });
    }
    return json_(200, { ok: true });
  }

  if (data.indexOf("faq:") === 0) {
    var key = data.replace(/^faq:/, "");
    tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id });
    tgCall_(token, "sendMessage", { chat_id: chatId, text: getFaqText_(key), reply_markup: getMainReplyKeyboard_() });
    return json_(200, { ok: true });
  }

  if (data === "menu:back") {
    tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id });
    tgSendWelcome_(token, chatId);
    return json_(200, { ok: true });
  }

  tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "Ок" });
  return json_(200, { ok: true });
}

function findOrderById_(orderId) {
  orderId = normalizeOrderId_(orderId);
  var cached = loadOrderDraftCache_(orderId);
  if (cached) return cached;

  var sheetId = getSheetId_();
  var sheetName = PropertiesService.getScriptProperties().getProperty("SHEET_ORDERS") || "Orders";
  if (!sheetId) return null;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return null;

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h || "").trim()] = i; });
  if (idx.order_id == null) return null;

  var lastRow = sh.getLastRow();
  var values = sh.getRange(2, 1, lastRow, sh.getLastColumn()).getValues();
  for (var r = 0; r < values.length; r++) {
    if (normalizeOrderId_(values[r][idx.order_id]) === orderId) {
      return {
        row: r + 2,
        orderId: orderId,
        createdAt: values[r][idx.created_at],
        source: values[r][idx.source],
        status: idx.status != null ? String(values[r][idx.status] || "") : "ACCEPTED",
        clientNotified: idx.status != null && String(values[r][idx.status] || "").indexOf("ACCEPTED") >= 0,
        client: {
          tgUserId: values[r][idx.tg_user_id],
          username: values[r][idx.username],
          firstName: values[r][idx.first_name],
          lastName: values[r][idx.last_name],
          phone: values[r][idx.phone],
          comment: values[r][idx.comment]
        },
        itemsText: values[r][idx.items],
        totals: {
          price: values[r][idx.total_price],
          kcal: values[r][idx.total_kcal],
          p: values[r][idx.total_p],
          f: values[r][idx.total_f],
          c: values[r][idx.total_c]
        },
        items: parseItemsText_(values[r][idx.items])
      };
    }
  }
  return null;
}

function markOrderStatus_(orderId, status) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty("SHEET_ID");
  var sheetName = props.getProperty("SHEET_ORDERS") || "Orders";
  if (!sheetId) return;
  var ss = SpreadsheetApp.openById(sheetId);
  var sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return;

  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idx = {};
  header.forEach(function (h, i) { idx[String(h || "").trim()] = i + 1; }); // 1-based
  if (!idx.order_id || !idx.status) return;

  var lastRow = sh.getLastRow();
  var values = sh.getRange(2, idx.order_id, lastRow, 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (normalizeOrderId_(values[r][0]) === normalizeOrderId_(orderId)) {
      sh.getRange(r + 2, idx.status).setValue(status);
      return;
    }
  }
}

function parseItemsText_(txt) {
  var lines = String(txt || "").split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
  return lines.map(function (line) {
    // "Name (Variant) × Q"
    var m = line.match(/^(.*)\s+×\s+(\d+)\s*$/);
    if (!m) return { name: line, variant: "", qty: 1 };
    var left = m[1];
    var qty = parseInt(m[2], 10) || 1;
    var vm = left.match(/^(.*)\s+\((.*)\)\s*$/);
    return { name: vm ? vm[1] : left, variant: vm ? vm[2] : "", qty: qty };
  });
}

function formatDraftForClient_(order) {
  var lines = [];
  lines.push("Проверьте заказ и подтвердите ✅");
  lines.push("");
  lines.push("Позиции:");
  (order.items || []).forEach(function (it) {
    lines.push("— " + it.name + (it.variant ? " (" + it.variant + ")" : "") + " × " + it.qty);
  });
  lines.push("");
  lines.push("Сумма: " + (order.totals && order.totals.price ? order.totals.price : 0) + " ₽");
  return lines.join("\n");
}

function json_(code, obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Выключить polling в Apps Script (обязательно, если бот на Amvera).
 * Run → disableTelegramPolling — иначе GAS забирает /start у Amvera.
 */
function disableTelegramPolling() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === "pollTelegramUpdates") ScriptApp.deleteTrigger(t);
  });
  Logger.log("Polling выключен. Сообщения должен обрабатывать бот на Amvera.");
}

/**
 * РЕКОМЕНДУЕМЫЙ режим для Telegram + Apps Script: polling (без webhook).
 * Telegram webhook на GAS Web App ломается (302/405) — см. README.
 *
 * Один раз: Run → enableTelegramPolling (в списке функций сверху).
 * Потом триггер раз в 1 минуту сам вызывает pollTelegramUpdates.
 * НЕ включай, если бот уже на Amvera — конфликт getUpdates.
 */
function enableTelegramPolling() {
  var token = getBotToken_();
  UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/deleteWebhook", { muteHttpExceptions: true });

  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === "pollTelegramUpdates") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("pollTelegramUpdates").timeBased().everyMinutes(1).create();
  setupBotUi();
  Logger.log("Polling включён: webhook удалён, триггер pollTelegramUpdates каждую минуту, меню бота обновлено.");
}

/** Один раз после обновления кода: Run → setupBotUi */
function setupBotUiPublic() {
  setupBotUi();
  Logger.log("Меню и кнопка Mini App обновлены. URL: " + getMiniAppUrl_());
}

function pollTelegramUpdates() {
  var props = PropertiesService.getScriptProperties();
  var token = getBotToken_();
  var offset = parseInt(props.getProperty("TG_OFFSET") || "0", 10) || 0;
  var url = "https://api.telegram.org/bot" + token + "/getUpdates?limit=50&timeout=0" + (offset ? "&offset=" + offset : "");
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText() || "{}");
  if (!data.ok) return;

  var updates = data.result || [];
  var nextOffset = offset;
  updates.forEach(function (u) {
    if (u.update_id >= nextOffset) nextOffset = u.update_id + 1;
    handleTelegramUpdate_(u);
  });
  if (nextOffset !== offset) props.setProperty("TG_OFFSET", String(nextOffset));
}

/**
 * Запусти вручную (Run → getMyLenaChatId) ПОСЛЕ /start боту.
 * Работает только если webhook выключен (deleteWebhook или enableTelegramPolling).
 */
function getMyLenaChatId() {
  var sheetId = getSheetId_();
  if (sheetId) {
    var ss = SpreadsheetApp.openById(sheetId);
    var sh = ss.getSheetByName("Chats");
    if (sh && sh.getLastRow() > 1) {
      var rows = sh.getRange(Math.max(2, sh.getLastRow() - 19), 1, sh.getLastRow() - Math.max(2, sh.getLastRow() - 19) + 1, 5).getValues();
      Logger.log("Последние контакты (лист Chats):");
      rows.forEach(function (r) {
        Logger.log("chat_id: " + r[1] + "  @" + r[2] + "  " + r[3] + " " + r[4] + "  text: " + r[5]);
      });
      return;
    }
  }

  var token = getBotToken_();
  var resp = UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/getUpdates", { muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText());
  var result = data.result || [];
  if (!result.length) {
    Logger.log("Нет новых сообщений в getUpdates (polling их уже забрал). Пусть Лена напишет /start и подожди 1 мин — смотри лист Chats в таблице.");
    return;
  }
  result.forEach(function (upd) {
    var msg = upd.message || upd.edited_message;
    if (msg) Logger.log("chat_id: " + msg.chat.id + "  username: " + (msg.from.username || "") + "  first_name: " + (msg.from.first_name || ""));
  });
}

/**
 * Используй, чтобы проверить, что бот шлёт сообщение тебе.
 * Сначала заполни Script Property LENA_CHAT_ID (или вставь напрямую ниже),
 * потом Run → testSendToLena.
 */
function testSendToLena() {
  var token = getBotToken_();
  var chatId = getLenaChatId_();
  if (!chatId) { Logger.log("LENA_CHAT_ID не задан"); return; }
  tgSend_(token, chatId, "✅ Тест пройден! Сайт ПП Феи успешно связан с ботом.", {});
  Logger.log("Сообщение отправлено на " + chatId);
}

function esc_(s) {
  return String(s || "").replace(/[&<>]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
  });
}

