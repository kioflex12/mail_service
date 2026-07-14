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

// Бесплатная модель OpenRouter (:free). Список — https://openrouter.ai/models?q=free
const MODEL = 'meta-llama/llama-3.3-70b-instruct:free';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TG_API = 'https://api.telegram.org/bot';

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
  getOrCreateLabel_();
  Logger.log('✅ Ежедневный триггер checkImportantMail поставлен на ~%s:00 (Europe/Moscow).', DAILY_HOUR);
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
    return;
  }
  const label = getOrCreateLabel_();
  const query = 'newer_than:' + LOOKBACK_DAYS + 'd -label:' + PROCESSED_LABEL +
                (SEARCH_QUERY_EXTRA ? ' ' + SEARCH_QUERY_EXTRA : '');
  const threads = GmailApp.search(query, 0, MAX_THREADS);
  if (!threads.length) { Logger.log('Новых неразобранных писем нет.'); return; }

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
}

// ============================================================
//  WEBHOOK (нажатия кнопок и текстовые сообщения)
// ============================================================

function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.s !== getSecret_()) {
      return ContentService.createTextOutput('forbidden');
    }
    const update = JSON.parse(e.postData.contents);

    // Дедуп: Telegram может переслать апдейт повторно, если ответ пришёл небыстро.
    const cache = CacheService.getScriptCache();
    const uKey = 'u_' + update.update_id;
    if (cache.get(uKey)) return ContentService.createTextOutput('ok');
    cache.put(uKey, '1', 120);

    if (update.callback_query) handleCallback_(update.callback_query);
    else if (update.message && update.message.text) handleMessage_(update.message);
  } catch (err) {
    Logger.log('doPost error: ' + err + (err && err.stack ? '\n' + err.stack : ''));
  }
  return ContentService.createTextOutput('ok');
}

function handleCallback_(cq) {
  const c = cfg_();
  const token = c.telegramToken;
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  const data = cq.data || '';
  const sep = data.indexOf(':');
  const action = sep >= 0 ? data.slice(0, sep) : data;
  const arg = sep >= 0 ? data.slice(sep + 1) : '';

  tgAnswerCb_(token, cq.id, ''); // гасим «часики» сразу

  try {
    switch (action) {
      case 'gen':   onGenerateReply_(c, chatId, arg); break;
      case 'send':  onSendReply_(c, chatId, arg); break;
      case 'gdraft':onSaveDraft_(c, chatId, arg); break;
      case 'redo':  onRedo_(c, chatId, arg); break;
      case 'cancel':onCancel_(c, chatId, arg); break;
      case 'arch':  GmailApp.getThreadById(arg).moveToArchive();
                    tgSend_(token, chatId, '📥 Письмо в архиве.'); break;
      case 'read':  GmailApp.getThreadById(arg).markRead();
                    tgSend_(token, chatId, '✅ Отмечено прочитанным.'); break;
      case 'summ':  onSummarize_(c, chatId, arg); break;
      case 'cal':   onCalendar_(c, chatId, arg); break;
      default:      tgSend_(token, chatId, 'Неизвестное действие.');
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

  // Ждём ли мы правку для черновика ответа?
  const cache = CacheService.getScriptCache();
  const editKey = 'edit_' + chatId;
  const draftId = cache.get(editKey);
  if (draftId) {
    cache.remove(editKey);
    onRedoWithText_(c, chatId, draftId, text);
    return;
  }
  if (text === '/start') {
    tgSend_(c.telegramToken, chatId, 'Привет! Я присылаю важные письма из Gmail с кнопками действий. Работаю по расписанию.');
  }
}

// ============================================================
//  ДЕЙСТВИЯ: ОТВЕТ
// ============================================================

function onGenerateReply_(c, chatId, threadId) {
  const email = emailFromThread_(threadId);
  const draft = generateReply_(email, null, null, c.openrouterKey);
  const id = Utilities.getUuid();
  CacheService.getScriptCache().put('d_' + id, JSON.stringify({ threadId: threadId, draft: draft }), 21600);
  tgSend_(c.telegramToken, chatId,
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
  const draft = generateReply_(email, st.draft, instructions, c.openrouterKey);
  st.draft = draft;
  CacheService.getScriptCache().put('d_' + id, JSON.stringify(st), 21600);
  tgSend_(c.telegramToken, chatId, '✍️ Обновлённый черновик:\n\n' + draft, { keyboard: draftKeyboard_(id) });
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
  const sys = 'Сожми письмо в 2–4 коротких пункта на русском. Только пункты списком, без вступления.';
  const usr = 'From: ' + email.from + '\nSubject: ' + email.subject + '\n\n' + email.body;
  const out = orComplete_(sys, usr, c.openrouterKey, 0.2);
  tgSend_(c.telegramToken, chatId, '🧾 Кратко:\n\n' + out);
}

function onCalendar_(c, chatId, threadId) {
  const email = emailFromThread_(threadId);
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
    tgSend_(c.telegramToken, chatId, '📅 Явной даты в письме не нашёл — событие не создал.');
    return;
  }
  const start = parseLocal_(ev.start);
  if (!start) { tgSend_(c.telegramToken, chatId, '📅 Не смог разобрать дату («' + ev.start + '»).'); return; }
  const end = (ev.end && parseLocal_(ev.end)) || new Date(start.getTime() + 60 * 60 * 1000);
  const title = ev.title || email.subject;
  CalendarApp.getDefaultCalendar().createEvent(title, start, end, {
    location: ev.location || '',
    description: 'Из письма: ' + email.subject + '\n' + email.from
  });
  tgSend_(c.telegramToken, chatId,
    '📅 Событие создано: «' + title + '» — ' +
    Utilities.formatDate(start, 'Europe/Moscow', 'dd.MM.yyyy HH:mm'));
}

// ============================================================
//  LLM (OpenRouter)
// ============================================================

function orComplete_(system, user, apiKey, temperature) {
  const payload = {
    model: MODEL,
    temperature: (temperature == null ? 0 : temperature),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  };
  const resp = UrlFetchApp.fetch(OPENROUTER_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'X-Title': 'mail-service' },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) throw new Error('OpenRouter API ' + code + ': ' + text.slice(0, 400));
  const data = JSON.parse(text);
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return ((msg && msg.content) || '').trim();
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
  const p = PropertiesService.getScriptProperties().getProperty('WEBAPP_URL');
  if (p) return p;
  const u = ScriptApp.getService().getUrl();
  if (!u) throw new Error('Нет URL Web App. Задеплой как Web App и впиши /exec URL в Script property WEBAPP_URL.');
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
