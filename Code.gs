/**
 * Gmail → Telegram: письма, требующие внимания, + кнопки действий.
 *
 * Каждое утро проверяет новые письма в Gmail, классифицирует их LLM через
 * OpenRouter и присылает важное в Telegram-бота. К каждому письму — кнопки:
 *   ✍️ Ответ (сгенерировать → апрув → отправить / в черновик Gmail / переписать),
 *   🧾 Саммари, 📅 В календарь, 📥 Архив, ✅ Прочитано.
 *
 * Бот интерактивный: нажатия кнопок приходят на webhook (doPost). Для этого
 * скрипт нужно задеплоить как Web App и один раз выполнить setupWebhook().
 *
 * Секреты — в Script Properties (Project Settings → Script properties),
 * НЕ в коде (репозиторий публичный):
 *   TELEGRAM_TOKEN      — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID    — id чата, куда слать (см. showMyChatId)
 *   OPENROUTER_API_KEY  — ключ OpenRouter (sk-or-v1-...)
 *   WEBAPP_URL          — (опц.) /exec URL Web App, если автоопределение не сработает
 *   WEBHOOK_SECRET      — (создаётся автоматически) секрет для защиты webhook
 *
 * Порядок настройки:
 *   1) заполнить 3 свойства (TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY)
 *   2) Deploy → New deployment → Web app (Execute as: Me, Access: Anyone) → авторизовать
 *   3) setupWebhook()   — привязать бота к webhook
 *   4) setup()          — поставить ежедневный триггер
 *   5) checkImportantMail() — проверить на реальной почте
 */

// ===== Настройки =====
const LOOKBACK_DAYS = 2;
const MAX_THREADS = 40;
const BATCH_SIZE = 20;
const BODY_CHARS = 1500;        // сколько тела письма шлём в классификатор
const REPLY_BODY_CHARS = 6000;  // сколько тела шлём в ответ/саммари/календарь
const DAILY_HOUR = 9;
const PROCESSED_LABEL = 'MailServiceProcessed';
const SEARCH_QUERY_EXTRA = 'in:anywhere';

// Аварийный список бесплатных моделей — используется, только если не удалось
// получить актуальный список из API OpenRouter (см. freeModels_). Обычно код
// сам подтягивает свежие :free-модели, руками этот список править не нужно.
const MODELS = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'meta-llama/llama-3.3-70b-instruct:free'
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TG_API = 'https://api.telegram.org/bot';

// Текст постоянной кнопки ручной проверки (над полем ввода).
const CHECK_BTN = '🔄 Проверить почту сейчас';

// URL опубликованного Web App (/exec) — для self-ping «прогрева» (keepWarm),
// чтобы контейнер не остывал и кнопки отвечали быстрее. Не секрет: POST всё равно
// требует ?s=<секрет>, а GET (doGet) отдаёт безобидную строку.
const WEB_APP_EXEC = 'https://script.google.com/macros/s/AKfycbw6ZJcB6GsxLaXW3jim_fvGLJ0ytgI94L5wDWW44gXeLpflpys2HydGURp73duvzxv91g/exec';

// ============================================================
//  РАЗОВАЯ НАСТРОЙКА
// ============================================================

function setup() {
  const c = cfg_();
  const missing = [];
  if (!c.telegramToken)  missing.push('TELEGRAM_TOKEN');
  if (!c.chatId)         missing.push('TELEGRAM_CHAT_ID');
  if (!c.openrouterKey)  missing.push('OPENROUTER_API_KEY');
  if (missing.length) {
    throw new Error('Не заполнены Script Properties: ' + missing.join(', ') + '.');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkImportantMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkImportantMail').timeBased().everyDays(1).atHour(DAILY_HOUR).create();

  // Прогрев: держим Web App-контейнер тёплым, чтобы кнопки отвечали быстрее (меньше холодных стартов).
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'keepWarm') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();

  getOrCreateLabel_();
  Logger.log('✅ Триггеры поставлены: ежедневная проверка ~%s:00 (Europe/Moscow) + прогрев каждые 5 мин.', DAILY_HOUR);
}

/** Прогрев: пингует свой Web App, чтобы контейнер не «остывал» и кнопки отвечали быстрее. */
function keepWarm() {
  try { UrlFetchApp.fetch(WEB_APP_EXEC, { muteHttpExceptions: true }); } catch (e) {}
}

/**
 * Разово (после деплоя Web App): привязывает бота к webhook.
 * Если автоопределение URL не сработает — впиши /exec URL в Script property WEBAPP_URL.
 */
function setupWebhook() {
  const c = cfg_();
  if (!c.telegramToken) { Logger.log('Заполни TELEGRAM_TOKEN.'); return; }
  const url = getWebAppUrl_();
  const secret = getSecret_();
  const hook = url + (url.indexOf('?') >= 0 ? '&' : '?') + 's=' + secret;
  const r = tgApi_(c.telegramToken, 'setWebhook', {
    url: hook,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });
  Logger.log('setWebhook: %s', JSON.stringify(r));
  Logger.log('Webhook URL: %s', hook);
  tgApi_(c.telegramToken, 'setMyCommands', {
    commands: [{ command: 'check', description: 'Проверить почту сейчас' }]
  });
  Logger.log('Команда /check зарегистрирована в меню бота.');
}

function getWebhookInfo() {
  Logger.log(JSON.stringify(tgApi_(cfg_().telegramToken, 'getWebhookInfo', {}), null, 2));
}

function deleteWebhook() {
  Logger.log(JSON.stringify(tgApi_(cfg_().telegramToken, 'deleteWebhook', { drop_pending_updates: true })));
}

// ============================================================
//  ЕЖЕДНЕВНАЯ ПРОВЕРКА (триггер)
// ============================================================

function checkImportantMail() {
  const c = cfg_();
  if (!c.telegramToken || !c.chatId || !c.openrouterKey) {
    Logger.log('⚠️ Не настроено. Заполни Script Properties и запусти setup().');
    return { scanned: 0, notified: 0 };
  }
  const label = getOrCreateLabel_();
  const query = 'newer_than:' + LOOKBACK_DAYS + 'd -label:' + PROCESSED_LABEL +
                (SEARCH_QUERY_EXTRA ? ' ' + SEARCH_QUERY_EXTRA : '');
  const threads = GmailApp.search(query, 0, MAX_THREADS);
  if (!threads.length) { Logger.log('Новых неразобранных писем нет.'); return { scanned: 0, notified: 0 }; }

  const items = threads.map(function (thread) {
    const msgs = thread.getMessages();
    const msg = msgs[msgs.length - 1];
    return {
      thread: thread,
      threadId: thread.getId(),
      from: msg.getFrom(),
      subject: msg.getSubject() || '(без темы)',
      body: (msg.getPlainBody() || '').slice(0, BODY_CHARS)
    };
  });

  let notified = 0;
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    let verdicts;
    try {
      verdicts = classifyBatch_(batch, c.openrouterKey);
    } catch (e) {
      Logger.log('❌ Ошибка классификации пачки: ' + e);
      continue;
    }
    batch.forEach(function (item, i) {
      const v = verdicts[i] || {};
      if (v.is_important) {
        tgSend_(c.telegramToken, c.chatId, buildMessage_(item, v),
                { html: true, keyboard: actionKeyboard_(item.threadId) });
        notified++;
      }
      item.thread.addLabel(label);
    });
    Utilities.sleep(500);
  }
  Logger.log('Разобрано писем: %s, отправлено в Telegram: %s.', items.length, notified);
  return { scanned: items.length, notified: notified };
}

// ============================================================
//  WEBHOOK (нажатия кнопок и текстовые сообщения)
// ============================================================

function doGet(e) {
  // Ответ для проверки в браузере, что деплой живой и доступен анонимно.
  return ContentService.createTextOutput('mail-service is running');
}

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.s !== getSecret_()) {
      return ContentService.createTextOutput('forbidden');
    }
    const update = JSON.parse(e.postData.contents);

    // Дедуп: Telegram повторяет доставку при 302/таймауте — обрабатываем апдейт ровно один раз.
    if (alreadyHandled_(update.update_id)) return ContentService.createTextOutput('ok');

    if (update.callback_query) handleCallback_(update.callback_query);
    else if (update.message && update.message.text) handleMessage_(update.message);
  } catch (err) {
    Logger.log('doPost error: ' + err + (err && err.stack ? '\n' + err.stack : ''));
  }
  return ContentService.createTextOutput('ok');
}

/** Обрабатываем каждый апдейт ровно один раз (Telegram повторяет доставку при 302/таймауте). */
function alreadyHandled_(updateId) {
  if (updateId == null) return false;
  const p = PropertiesService.getScriptProperties();
  let arr = [];
  try { arr = JSON.parse(p.getProperty('seen_updates') || '[]'); } catch (e) {}
  if (arr.indexOf(updateId) >= 0) return true;
  arr.push(updateId);
  if (arr.length > 300) arr = arr.slice(-300);
  p.setProperty('seen_updates', JSON.stringify(arr));
  return false;
}

function handleCallback_(cq) {
  const c = cfg_();
  const token = c.telegramToken;
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const messageId = cq.message && cq.message.message_id;
  const data = cq.data || '';
  const sep = data.indexOf(':');
  const action = sep >= 0 ? data.slice(0, sep) : data;
  const arg = sep >= 0 ? data.slice(sep + 1) : '';

  // Гасим «часики» с коротким всплывающим текстом (для долгих действий — «секунду»).
  let toast = '';
  if (action === 'gen' || action === 'summ' || action === 'cal') toast = '⏳ Секунду…';
  else if (action === 'read') toast = '✅ Прочитано';
  else if (action === 'arch') toast = '📥 В архиве';
  tgAnswerCb_(token, cq.id, toast);

  try {
    switch (action) {
      case 'gen':    onGenerateReply_(c, chatId, arg); break;
      case 'send':   onSendReply_(c, chatId, arg); break;
      case 'gdraft': onSaveDraft_(c, chatId, arg); break;
      case 'redo':   onRedo_(c, chatId, arg); break;
      case 'cancel': onCancel_(c, chatId, arg); break;
      // read/архив: сначала мгновенно убираем карточку, операцию в Gmail делаем после
      case 'arch':   tgDelete_(token, chatId, messageId); GmailApp.getThreadById(arg).moveToArchive(); break;
      case 'read':   tgDelete_(token, chatId, messageId); GmailApp.getThreadById(arg).markRead();      break;
      case 'summ':   onSummarize_(c, chatId, arg); break;
      case 'cal':    onCalendar_(c, chatId, arg); break;
      default:       tgSend_(token, chatId, 'Неизвестное действие.');
    }
  } catch (err) {
    tgSend_(token, chatId, '⚠️ Не получилось: ' + err);
    Logger.log('callback ' + action + ' error: ' + err);
  }
}

function handleMessage_(msg) {
  const c = cfg_();
  const chatId = msg.chat.id;
  const text = (msg.text || '').trim();

  // Ручная проверка — командой или кнопкой. Мгновенно шлём «принял», а тяжёлую
  // работу выносим в фоновый триггер (иначе Telegram зациклит повтор при 302).
  if (text === '/check' || text === CHECK_BTN) {
    tgSend_(c.telegramToken, chatId, '🔄 Принял, проверяю почту…');
    scheduleDeferredCheck_();
    return;
  }

  if (text === '/start') {
    tgSend_(c.telegramToken, chatId,
      'Привет! Я присылаю важные письма из Gmail с кнопками действий. Работаю по расписанию (~9:00), ' +
      'а кнопкой ниже (или командой /check) можно проверить вручную — покажу, что взял в работу, и пришлю итог.',
      { keyboard: mainReplyKeyboard_() });
    return;
  }

  // Ждём ли мы правку для черновика ответа?
  const cache = CacheService.getScriptCache();
  const editKey = 'edit_' + chatId;
  const draftId = cache.get(editKey);
  if (draftId) {
    cache.remove(editKey);
    onRedoWithText_(c, chatId, draftId, text);
    return;
  }
}

/** Ставит одноразовый триггер, который через пару секунд тихо прогонит проверку почты. */
function scheduleDeferredCheck_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'deferredCheck') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('deferredCheck').timeBased().after(2000).create();
}

/** Прогон РУЧНОЙ проверки вне webhook: doPost ответил мгновенно, здесь делаем работу
 *  и шлём итог в чат. (Автоматическая утренняя проверка идёт мимо — без статуса.) */
function deferredCheck() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'deferredCheck') ScriptApp.deleteTrigger(t);
  });
  const c = cfg_();
  const r = checkImportantMail() || { scanned: 0, notified: 0 };
  const msg = r.scanned === 0
    ? '📭 Новых писем нет.'
    : '✅ Готово: разобрано ' + r.scanned + ', важных ' + r.notified + '.';
  if (c.telegramToken && c.chatId) tgSend_(c.telegramToken, c.chatId, msg);
}

/** Постоянная кнопка ручной проверки над полем ввода. */
function mainReplyKeyboard_() {
  return { keyboard: [[{ text: CHECK_BTN }]], resize_keyboard: true, is_persistent: true };
}

// ============================================================
//  ДЕЙСТВИЯ: ОТВЕТ
// ============================================================

function onGenerateReply_(c, chatId, threadId) {
  const email = emailFromThread_(threadId);
  const mid = tgProgress_(c.telegramToken, chatId, '✍️ Пишу ответ…');
  const draft = generateReply_(email, null, null, c.openrouterKey);
  const id = Utilities.getUuid();
  CacheService.getScriptCache().put('d_' + id, JSON.stringify({ threadId: threadId, draft: draft }), 21600);
  tgFinish_(c.telegramToken, chatId, mid,
    '✍️ Черновик ответа (тема: ' + email.subject + '):\n\n' + draft,
    { keyboard: draftKeyboard_(id) });
}

function onRedo_(c, chatId, id) {
  const raw = CacheService.getScriptCache().get('d_' + id);
  if (!raw) { tgSend_(c.telegramToken, chatId, 'Черновик устарел, сгенерируй заново.'); return; }
  CacheService.getScriptCache().put('edit_' + chatId, id, 3600);
  tgSend_(c.telegramToken, chatId, '✏️ Пришли одним сообщением, что поправить в ответе (тон, факты, длину…).');
}

function onRedoWithText_(c, chatId, id, instructions) {
  const raw = CacheService.getScriptCache().get('d_' + id);
  if (!raw) { tgSend_(c.telegramToken, chatId, 'Черновик устарел, сгенерируй заново.'); return; }
  const st = JSON.parse(raw);
  const email = emailFromThread_(st.threadId);
  const mid = tgProgress_(c.telegramToken, chatId, '✍️ Переписываю…');
  const draft = generateReply_(email, st.draft, instructions, c.openrouterKey);
  st.draft = draft;
  CacheService.getScriptCache().put('d_' + id, JSON.stringify(st), 21600);
  tgFinish_(c.telegramToken, chatId, mid, '✍️ Обновлённый черновик:\n\n' + draft, { keyboard: draftKeyboard_(id) });
}

function onSendReply_(c, chatId, id) {
  const raw = CacheService.getScriptCache().get('d_' + id);
  if (!raw) { tgSend_(c.telegramToken, chatId, 'Черновик устарел, сгенерируй заново.'); return; }
  const st = JSON.parse(raw);
  GmailApp.getThreadById(st.threadId).reply(st.draft);
  CacheService.getScriptCache().remove('d_' + id);
  tgSend_(c.telegramToken, chatId, '✅ Ответ отправлен.');
}

function onSaveDraft_(c, chatId, id) {
  const raw = CacheService.getScriptCache().get('d_' + id);
  if (!raw) { tgSend_(c.telegramToken, chatId, 'Черновик устарел, сгенерируй заново.'); return; }
  const st = JSON.parse(raw);
  const thread = GmailApp.getThreadById(st.threadId);
  const msgs = thread.getMessages();
  msgs[msgs.length - 1].createDraftReply(st.draft);
  CacheService.getScriptCache().remove('d_' + id);
  tgSend_(c.telegramToken, chatId, '📝 Черновик сохранён в Gmail — правь и отправляй из почты.');
}

function onCancel_(c, chatId, id) {
  CacheService.getScriptCache().remove('d_' + id);
  tgSend_(c.telegramToken, chatId, '✖ Отменено.');
}

// ============================================================
//  ДЕЙСТВИЯ: САММАРИ / КАЛЕНДАРЬ
// ============================================================

function onSummarize_(c, chatId, threadId) {
  const email = emailFromThread_(threadId);
  const mid = tgProgress_(c.telegramToken, chatId, '🧾 Готовлю саммари…');
  const sys = 'Сожми письмо в 2–4 коротких пункта на русском. Только пункты списком, без вступления.';
  const usr = 'From: ' + email.from + '\nSubject: ' + email.subject + '\n\n' + email.body;
  const out = orComplete_(sys, usr, c.openrouterKey, 0.2);
  tgFinish_(c.telegramToken, chatId, mid, '🧾 Кратко:\n\n' + out);
}

function onCalendar_(c, chatId, threadId) {
  const email = emailFromThread_(threadId);
  const mid = tgProgress_(c.telegramToken, chatId, '📅 Ищу дату в письме…');
  const sys =
    'Извлеки из письма событие (встреча, дедлайн, запись, созвон). Ответь ТОЛЬКО JSON без markdown: ' +
    '{"has_event":<bool>,"title":"<кратко>","start":"YYYY-MM-DD HH:mm","end":"YYYY-MM-DD HH:mm или пусто",' +
    '"location":"<или пусто>"}. Если явной даты/времени нет — has_event=false. Год по умолчанию текущий, ' +
    'время по умолчанию 10:00 если не указано.';
  const usr = 'Сегодня: ' + Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd') +
              '\nFrom: ' + email.from + '\nSubject: ' + email.subject + '\n\n' + email.body;
  const out = orComplete_(sys, usr, c.openrouterKey, 0);
  const ev = extractJson_(out);
  if (!ev || !ev.has_event || !ev.start) {
    tgFinish_(c.telegramToken, chatId, mid, '📅 Явной даты в письме не нашёл — событие не создал.');
    return;
  }
  const start = parseLocal_(ev.start);
  if (!start) { tgFinish_(c.telegramToken, chatId, mid, '📅 Не смог разобрать дату («' + ev.start + '»).'); return; }
  const end = (ev.end && parseLocal_(ev.end)) || new Date(start.getTime() + 60 * 60 * 1000);
  const title = ev.title || email.subject;
  CalendarApp.getDefaultCalendar().createEvent(title, start, end, {
    location: ev.location || '',
    description: 'Из письма: ' + email.subject + '\n' + email.from
  });
  tgFinish_(c.telegramToken, chatId, mid,
    '📅 Событие создано: «' + title + '» — ' +
    Utilities.formatDate(start, 'Europe/Moscow', 'dd.MM.yyyy HH:mm'));
}

// ============================================================
//  LLM (OpenRouter)
// ============================================================

function orComplete_(system, user, apiKey, temperature) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
  const models = freeModels_();
  let lastErr = '';

  // Перебираем модели: занятую/недоступную пропускаем, берём следующую.
  for (let mi = 0; mi < models.length; mi++) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = UrlFetchApp.fetch(OPENROUTER_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'X-Title': 'mail-service' },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          model: models[mi],
          temperature: (temperature == null ? 0 : temperature),
          messages: messages
        })
      });
      const code = resp.getResponseCode();
      const text = resp.getContentText();

      if (code === 200) {
        const data = JSON.parse(text);
        const msg = data.choices && data.choices[0] && data.choices[0].message;
        const content = (msg && msg.content) || '';
        if (content.trim()) return content.trim();
        lastErr = models[mi] + ': пустой ответ';
        break; // к следующей модели
      }

      // 429/5xx — временно: один короткий ретрай с учётом Retry-After, иначе следующая модель.
      if (code === 429 || code >= 500) {
        lastErr = 'API ' + code + ' на ' + models[mi];
        const waitMs = retryAfterMs_(text);
        if (attempt === 0 && waitMs > 0 && waitMs <= 8000) { Utilities.sleep(waitMs); continue; }
        break;
      }

      // 400/404 и прочее (напр. модель недоступна для free) — сразу следующая модель.
      lastErr = 'API ' + code + ' на ' + models[mi] + ': ' + text.slice(0, 150);
      break;
    }
  }
  throw new Error('OpenRouter: не ответила ни одна из бесплатных моделей. ' + lastErr);
}

/**
 * Актуальный список бесплатных чат-моделей OpenRouter (кэш 6 ч).
 * Тянется из /api/v1/models, поэтому не устаревает при смене :free-слагов.
 * Фолбэк на зашитый MODELS, если запрос не удался.
 */
function freeModels_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('freemodels');
  if (cached) { try { const a = JSON.parse(cached); if (a.length) return a; } catch (e) {} }
  try {
    const resp = UrlFetchApp.fetch('https://openrouter.ai/api/v1/models', { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      const ids = (data.data || []).filter(function (m) {
        const pr = m.pricing || {};
        return String(m.id).slice(-5) === ':free' &&
               Number(pr.prompt || 0) === 0 && Number(pr.completion || 0) === 0;
      }).map(function (m) { return m.id; });
      const ordered = orderModels_(ids);
      if (ordered.length) { cache.put('freemodels', JSON.stringify(ordered), 21600); return ordered; }
    }
  } catch (e) { Logger.log('freeModels_ error: ' + e); }
  return MODELS.slice();
}

/** Упорядочивает бесплатные модели: пригодные для чата — вперёд, спорные (coder/vision/…) — в конец; максимум 8. */
function orderModels_(ids) {
  const prefer = ['qwen3-next', 'gpt-oss', 'gemma-4', 'gemma', 'llama-3.3', 'nemotron-3-super', 'hermes', 'mistral', 'deepseek', 'qwen'];
  const avoid = /coder|vision|-vl|safety|guard|embed|reasoning|tts|whisper|image/i;
  const good = ids.filter(function (id) { return !avoid.test(id); });
  const rest = ids.filter(function (id) { return avoid.test(id); });
  function rank(id) { for (var i = 0; i < prefer.length; i++) { if (id.indexOf(prefer[i]) >= 0) return i; } return prefer.length; }
  good.sort(function (a, b) { return rank(a) - rank(b); });
  return good.concat(rest).slice(0, 8);
}

/** Достаёт паузу перед ретраем (мс) из ошибки OpenRouter/429. 0 если не нашли. */
function retryAfterMs_(text) {
  try {
    const j = JSON.parse(text);
    const s = j && j.error && j.error.metadata && j.error.metadata.retry_after_seconds;
    if (s) return Math.ceil(Number(s) * 1000);
  } catch (e) {}
  return 1500;
}

function classifyBatch_(batch, apiKey) {
  const listText = batch.map(function (it, i) {
    return '[' + i + ']\nFrom: ' + it.from + '\nSubject: ' + it.subject + '\nBody (truncated): ' + it.body;
  }).join('\n\n---\n\n');

  const system =
    'Ты — персональный фильтр входящей почты. Для каждого письма реши, требует ли оно ' +
    'личного внимания получателя. Считай важным (is_important=true):\n' +
    '• работа: вакансии, офферы, рекрутёры, приглашения на собеседование, отклики, job-платформы (hh.ru, LinkedIn);\n' +
    '• личные письма от реального человека, ждущие ответа;\n' +
    '• деньги: счета, подозрительные списания, возвраты, важные банковские уведомления;\n' +
    '• безопасность: вход в аккаунт, смена пароля, 2FA, подозрительная активность;\n' +
    '• сроки: дедлайны, встречи, записи, напоминания к дате;\n' +
    '• срочные запросы, требующие действия; официальные/госуведомления.\n' +
    'НЕ важным считай: рассылки, маркетинг/промо, дайджесты, соцсети-уведомления, автошум, рекламу, ' +
    'чеки без требуемого действия. Ставь is_important=true только если реально стоит побеспокоить.\n\n' +
    'Ответь ТОЛЬКО валидным JSON, без markdown, ровно по одному объекту на письмо: ' +
    '{"results":[{"i":<int>,"is_important":<bool>,' +
    '"category":"<work|personal|finance|security|deadline|urgent|other>","reason":"<фраза на русском>"}]}';

  const user = 'Классифицируй письма (сопоставляй по индексу i, 0-based):\n\n' + listText;
  const out = orComplete_(system, user, apiKey, 0);
  const parsed = extractJson_(out);
  if (!parsed) throw new Error('Модель вернула не JSON: ' + out.slice(0, 300));
  const byIndex = {};
  (parsed.results || []).forEach(function (r) { byIndex[r.i] = r; });
  return batch.map(function (_, i) {
    return byIndex[i] || { is_important: false, category: 'other', reason: 'нет ответа модели' };
  });
}

function generateReply_(email, prevDraft, instructions, apiKey) {
  const system =
    'Ты пишешь ответ на письмо от лица получателя. Пиши на языке письма, вежливо и по делу, ' +
    'без выдуманных фактов и обещаний. Верни ТОЛЬКО текст ответа — без темы, без «From/To», ' +
    'без пояснений. Не придумывай имя/подпись, если их нет в контексте.';
  let user = 'Письмо, на которое отвечаем:\nFrom: ' + email.from + '\nSubject: ' + email.subject +
             '\n\n' + email.body;
  if (prevDraft) {
    user += '\n\n---\nТвой предыдущий черновик ответа:\n' + prevDraft +
            '\n\n---\nПоправь его с учётом пожеланий пользователя: ' + (instructions || '');
  }
  return orComplete_(system, user, apiKey, 0.4);
}

// ============================================================
//  TELEGRAM helpers
// ============================================================

function tgApi_(token, method, payload) {
  const resp = UrlFetchApp.fetch(TG_API + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });
  const body = resp.getContentText();
  if (resp.getResponseCode() !== 200) Logger.log('⚠️ Telegram %s: %s', method, body.slice(0, 300));
  return JSON.parse(body);
}

function tgSend_(token, chatId, text, opts) {
  opts = opts || {};
  const p = { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  if (opts.html) p.parse_mode = 'HTML';
  if (opts.keyboard) p.reply_markup = opts.keyboard;
  return tgApi_(token, 'sendMessage', p);
}

function tgAnswerCb_(token, id, text) {
  return tgApi_(token, 'answerCallbackQuery', { callback_query_id: id, text: text || '' });
}

/** Отправляет «⏳ готовлю…» и возвращает message_id, чтобы потом заменить его результатом. */
function tgProgress_(token, chatId, text) {
  const r = tgSend_(token, chatId, text);
  return r && r.result && r.result.message_id;
}

/** Заменяет ранее отправленное сообщение результатом (или шлёт новое, если id нет). */
function tgFinish_(token, chatId, messageId, text, opts) {
  if (messageId) return tgEdit_(token, chatId, messageId, text, opts);
  return tgSend_(token, chatId, text, opts);
}

function tgEdit_(token, chatId, messageId, text, opts) {
  opts = opts || {};
  const p = { chat_id: chatId, message_id: messageId, text: String(text).slice(0, 4000), disable_web_page_preview: true };
  if (opts.html) p.parse_mode = 'HTML';
  if (opts.keyboard) p.reply_markup = opts.keyboard;
  return tgApi_(token, 'editMessageText', p);
}

function tgDelete_(token, chatId, messageId) {
  if (!messageId) return;
  return tgApi_(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

function actionKeyboard_(threadId) {
  return {
    inline_keyboard: [
      [{ text: '✍️ Ответ', callback_data: 'gen:' + threadId }, { text: '🧾 Саммари', callback_data: 'summ:' + threadId }],
      [{ text: '📅 В календарь', callback_data: 'cal:' + threadId }],
      [{ text: '📥 Архив', callback_data: 'arch:' + threadId }, { text: '✅ Прочитано', callback_data: 'read:' + threadId }]
    ]
  };
}

function draftKeyboard_(id) {
  return {
    inline_keyboard: [
      [{ text: '✅ Отправить', callback_data: 'send:' + id }],
      [{ text: '📝 В черновик Gmail', callback_data: 'gdraft:' + id }, { text: '✏️ Переписать', callback_data: 'redo:' + id }],
      [{ text: '✖ Отмена', callback_data: 'cancel:' + id }]
    ]
  };
}

// ============================================================
//  СООБЩЕНИЕ О ПИСЬМЕ
// ============================================================

function emojiFor_(category) {
  const map = { work: '💼', personal: '✉️', finance: '💰', security: '🔐', deadline: '⏰', urgent: '🚨', other: '🔔' };
  return map[category] || '🔔';
}

function buildMessage_(item, verdict) {
  const link = 'https://mail.google.com/mail/u/0/#all/' + item.threadId;
  const snippet = (item.body || '').replace(/\s+/g, ' ').slice(0, 300);
  const cat = verdict.category || 'other';
  return emojiFor_(cat) + ' <b>Требует внимания</b> (<i>' + escapeHtml_(cat) + '</i>)\n\n' +
         '<b>Тема:</b> ' + escapeHtml_(item.subject) + '\n' +
         '<b>От:</b> ' + escapeHtml_(item.from) + '\n' +
         '<b>Почему:</b> ' + escapeHtml_(verdict.reason || '') + '\n\n' +
         escapeHtml_(snippet) + '\n\n' +
         '🔗 <a href="' + link + '">Открыть в Gmail</a>';
}

// ============================================================
//  ВСПОМОГАТЕЛЬНЫЕ
// ============================================================

function cfg_() {
  const p = PropertiesService.getScriptProperties();
  return {
    telegramToken: p.getProperty('TELEGRAM_TOKEN'),
    chatId: p.getProperty('TELEGRAM_CHAT_ID'),
    openrouterKey: p.getProperty('OPENROUTER_API_KEY')
  };
}

function getSecret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty('WEBHOOK_SECRET');
  if (!s) { s = Utilities.getUuid().replace(/-/g, ''); p.setProperty('WEBHOOK_SECRET', s); }
  return s;
}

function getWebAppUrl_() {
  let u = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '';
  if (!u) u = ScriptApp.getService().getUrl() || '';
  u = u.split('?')[0].trim(); // убираем query, чтобы не задвоился ?s=
  if (!u) {
    throw new Error('Нет URL Web App. Deploy → New deployment → Web app (Access: Anyone), ' +
                    'скопируй /exec URL и впиши в Script property WEBAPP_URL.');
  }
  if (/\/dev$/.test(u)) {
    throw new Error('Это /dev-URL — Telegram получит 401. Нужен /exec: Deploy → New deployment → ' +
                    'Web app (Access: Anyone), скопируй адрес, оканчивающийся на /exec, ' +
                    'и впиши его в Script property WEBAPP_URL, затем запусти setupWebhook снова.');
  }
  return u;
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
}

function emailFromThread_(threadId) {
  const thread = GmailApp.getThreadById(threadId);
  if (!thread) throw new Error('Тред не найден: ' + threadId);
  const msgs = thread.getMessages();
  const msg = msgs[msgs.length - 1];
  return {
    from: msg.getFrom(),
    subject: msg.getSubject() || '(без темы)',
    body: (msg.getPlainBody() || '').slice(0, REPLY_BODY_CHARS)
  };
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Достаёт JSON-объект из текста (терпит markdown/обёртки). Возвращает объект или null. */
function extractJson_(text) {
  const s = String(text).indexOf('{');
  const e = String(text).lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(String(text).slice(s, e + 1)); } catch (err) { return null; }
}

/** «YYYY-MM-DD HH:mm» (или с 'T') → Date в локальной таймзоне. null если не разобрать. */
function parseLocal_(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0);
}

// ============================================================
//  ОТЛАДКА
// ============================================================

function showMyChatId() {
  const token = cfg_().telegramToken;
  if (!token) { Logger.log('Заполни TELEGRAM_TOKEN.'); return; }
  const data = tgApi_(token, 'getUpdates', {});
  if (!data.ok) { Logger.log('Ошибка: ' + JSON.stringify(data)); return; }
  if (!data.result.length) { Logger.log('Нет апдейтов. Напиши боту сообщение и запусти снова.'); return; }
  data.result.forEach(function (u) {
    const chat = (u.message && u.message.chat) || (u.channel_post && u.channel_post.chat);
    if (chat) Logger.log('chat_id=%s (%s %s / %s)', chat.id, chat.first_name || '', chat.last_name || '', chat.type);
  });
}

function sendTestMessage() {
  const c = cfg_();
  if (!c.telegramToken || !c.chatId) { Logger.log('Заполни TELEGRAM_TOKEN и TELEGRAM_CHAT_ID.'); return; }
  tgSend_(c.telegramToken, c.chatId, '✅ Тест: бот mail-service подключён.');
  Logger.log('Отправлено. Проверь Telegram.');
}

function testModel() {
  const c = cfg_();
  if (!c.openrouterKey) { Logger.log('Заполни OPENROUTER_API_KEY.'); return; }
  const v = classifyBatch_([{
    from: 'HeadHunter <no-reply@hh.ru>',
    subject: 'Ваше резюме заинтересовало работодателя',
    body: 'Здравствуйте! Компания приглашает вас на собеседование в четверг в 15:00.'
  }], c.openrouterKey);
  Logger.log('Модель: %s', JSON.stringify(v[0]));
}
