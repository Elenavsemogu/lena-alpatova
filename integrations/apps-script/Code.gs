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
var HARDCODED_SHEET_ID = "1d4vyOwUcHbAYS9mFc0oUWjbghYqcDrlQ8xS23m8E1to";
var DEFAULT_MINI_APP_URL = "https://xn--e1atau0d.xn--p1ai/"; // ппфея.рф

function getSheetId_() {
  return PropertiesService.getScriptProperties().getProperty("SHEET_ID") || HARDCODED_SHEET_ID;
}

function getMiniAppUrl_() {
  return PropertiesService.getScriptProperties().getProperty("MINI_APP_URL") || DEFAULT_MINI_APP_URL;
}

function normalizeOrderId_(orderId) {
  var id = String(orderId || "").trim();
  while (id.indexOf("order_") === 0) id = id.slice("order_".length);
  return id;
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
      items: p.items || [],
      totals: p.totals || {},
      client: p.client || {},
      source: p.source || "web"
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
  if (payload && payload.type === "order_draft") {
    return handleOrderDraft_(payload);
  }
  if (e && e.parameter && e.parameter.type === "order_draft" && e.parameter.data) {
    try {
      payload = JSON.parse(String(e.parameter.data));
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
    // Telegram updates приходят без нашего поля type — у них есть update_id
    if (payload && payload.update_id) return handleTelegramUpdate_(payload);

    var type = payload.type || "order";

    if (type === "order") return handleOrder_(payload);
    if (type === "order_draft") return handleOrderDraft_(payload);
    if (type === "questionnaire") return handleQuestionnaire_(payload);

    return json_(200, { ok: true, ignored: true, type: type });
  } catch (err) {
    return json_(200, { ok: false, error: String(err) });
  }
}

/**
 * Черновик заказа: записываем в Google Sheets и возвращаем orderId.
 * Затем сайт открывает бота: https://t.me/pp_fairy_bot?start=order_<orderId>
 */
function handleOrderDraft_(p) {
  var sheetId = getSheetId_();
  var sheetName = PropertiesService.getScriptProperties().getProperty("SHEET_ORDERS") || "Orders";

  var ts = new Date();
  var orderId = normalizeOrderId_(p.orderId || ("ord_" + Utilities.getUuid().replace(/-/g, "").slice(0, 16)));
  var source = p.source || "web";
  var client = p.client || {};
  var items = p.items || [];
  var totals = p.totals || {};

  saveOrderDraftCache_(orderId, { orderId: orderId, source: source, client: client, items: items, totals: totals, ts: ts });

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
      totals.c || "",
      orderId,
      "DRAFT"
    ]);
  }

  return json_(200, { ok: true, orderId: orderId });
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
  var botToken = props.getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
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
  var token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
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
    tgSend_(token, String(chatId), "Не нашла заказ. Возможно, ссылка устарела. Попробуйте оформить заказ ещё раз на сайте.", {});
    return json_(200, { ok: true });
  }

  var txt = formatDraftForClient_(order);
  var kb = {
    inline_keyboard: [
      [{ text: "✅ Подтвердить заказ", callback_data: "confirm:" + orderId }],
      [{ text: "✏️ Редактировать (на сайте)", url: getMiniAppUrl_() + "?editOrder=" + encodeURIComponent(orderId) }]
    ]
  };

  tgCall_(token, "sendMessage", { chat_id: chatId, text: txt, reply_markup: kb });
  return json_(200, { ok: true });
}

function tgHandleCallback_(token, cq) {
  var data = String(cq.data || "");
  var chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;

  if (data.indexOf("confirm:") === 0) {
    var orderId = data.replace(/^confirm:/, "");
    var order = findOrderById_(orderId);
    if (!order) {
      tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "Заказ не найден" });
      return json_(200, { ok: true });
    }

    markOrderStatus_(orderId, "CONFIRMED");
    var finalText = formatOrderForClient_(order.items, order.totals) + "\n\nЕсли нужно что-то изменить — напишите Елене, пожалуйста.";
    tgCall_(token, "answerCallbackQuery", { callback_query_id: cq.id, text: "Принято ✅" });
    tgCall_(token, "sendMessage", { chat_id: chatId, text: finalText, disable_web_page_preview: true, reply_markup: getMainReplyKeyboard_() });

    var lenaChatId = PropertiesService.getScriptProperties().getProperty("LENA_CHAT_ID");
    if (lenaChatId) {
      var lenaText = formatOrderForLena_(new Date(), order.source || "web", order.client || {}, order.items, order.totals);
      tgSend_(token, lenaChatId, lenaText, { parse_mode: "HTML", disable_web_page_preview: true });
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
        createdAt: values[r][idx.created_at],
        source: values[r][idx.source],
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

  var values = sh.getRange(2, idx.order_id, sh.getLastRow() - 1, 1).getValues();
  for (var r = 0; r < values.length; r++) {
    if (String(values[r][0]) === String(orderId)) {
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
 * РЕКОМЕНДУЕМЫЙ режим для Telegram + Apps Script: polling (без webhook).
 * Telegram webhook на GAS Web App ломается (302/405) — см. README.
 *
 * Один раз: Run → enableTelegramPolling (в списке функций сверху).
 * Потом триггер раз в 1 минуту сам вызывает pollTelegramUpdates.
 */
function enableTelegramPolling() {
  var token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
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
  var token = props.getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
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

  var token = PropertiesService.getScriptProperties().getProperty("BOT_TOKEN") || HARDCODED_BOT_TOKEN;
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

