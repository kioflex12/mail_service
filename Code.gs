/**
 * Gmail → Telegram: письма, требующие внимания.
 *
 * Каждое утро проверяет новые письма в Gmail, классифицирует их моделью Google
 * Gemini («требует ли это личного внимания» — работа, личные сообщения, деньги,
 * безопасность, дедлайны, срочные запросы и т.п.) и присылает важное в Telegram-бота.
 *
 * Классификатор — Gemini (бесплатный тариф Google AI Studio: https://aistudio.google.com/apikey).
 *
 * Секреты хранятся в Script Properties (Project Settings → Script properties),
 * НЕ в коде (репозиторий публичный — ключи в код НЕ вставлять):
 *   TELEGRAM_TOKEN      — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID    — id чата, куда слать (см. showMyChatId ниже)
 *   GEMINI_API_KEY      — ключ Google AI Studio (бесплатный)
 *
 * Разовая настройка: заполнить три свойства → запустить setup() один раз
 * (создаст ежедневный триггер и выдаст OAuth-согласия).
 */

// ===== Настройки (можно менять прямо здесь) =====
const LOOKBACK_DAYS = 2;                 // окно поиска писем; 2 дня = запас перекрытия при ежедневном запуске
const MAX_THREADS = 40;                  // максимум писем за один запуск (защита от лавины)
const BATCH_SIZE = 20;                   // сколько писем отдаём модели за один запрос
const BODY_CHARS = 1500;                 // до скольких символов тела письма урезаем перед отправкой в модель
const DAILY_HOUR = 9;                    // час ежедневного запуска в таймзоне проекта (Europe/Moscow в appsscript.json)
const PROCESSED_LABEL = 'MailServiceProcessed'; // метка, которой помечаем разобранные письма (защита от повторов)
const SEARCH_QUERY_EXTRA = 'in:anywhere'; // где искать: in:anywhere = вся почта. Можно сузить до 'in:inbox' или 'category:primary'.

// Модель-классификатор Gemini (бесплатный тариф). gemini-2.5-flash — быстрая и бесплатная.
// Если упрётся в квоту/недоступность — попробуй 'gemini-2.0-flash'.
const MODEL = 'gemini-2.5-flash';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// ============================================================
//  РАЗОВАЯ НАСТРОЙКА
// ============================================================

/**
 * Запусти ОДИН РАЗ после того, как заполнил Script Properties.
 * Проверяет конфиг, ставит ежедневный триггер и запрашивает OAuth-согласия.
 */
function setup() {
  const c = cfg_();
  const missing = [];
  if (!c.telegramToken) missing.push('TELEGRAM_TOKEN');
  if (!c.chatId)        missing.push('TELEGRAM_CHAT_ID');
  if (!c.geminiKey)     missing.push('GEMINI_API_KEY');
  if (missing.length) {
    throw new Error('Не заполнены Script Properties: ' + missing.join(', ') +
      '. Project Settings → Script properties, затем запусти setup() снова.');
  }

  // Убираем старые триггеры этой функции, чтобы не плодить дубли.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkImportantMail') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('checkImportantMail')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_HOUR)
    .create();

  getOrCreateLabel_(); // создаём метку заранее
  Logger.log('✅ Готово. Ежедневный триггер checkImportantMail поставлен на ~%s:00 (Europe/Moscow).', DAILY_HOUR);
  Logger.log('Проверить прямо сейчас можно, запустив checkImportantMail вручную.');
}

// ============================================================
//  ОСНОВНАЯ ЛОГИКА (её дёргает триггер каждое утро)
// ============================================================

function checkImportantMail() {
  const c = cfg_();
  if (!c.telegramToken || !c.chatId || !c.geminiKey) {
    Logger.log('⚠️ Не настроено. Заполни Script Properties и запусти setup().');
    return;
  }

  const label = getOrCreateLabel_();
  const query = 'newer_than:' + LOOKBACK_DAYS + 'd -label:' + PROCESSED_LABEL +
                (SEARCH_QUERY_EXTRA ? ' ' + SEARCH_QUERY_EXTRA : '');

  const threads = GmailApp.search(query, 0, MAX_THREADS);
  if (!threads.length) {
    Logger.log('Новых неразобранных писем нет.');
    return;
  }

  // Собираем кандидатов из последнего сообщения каждого треда.
  const items = threads.map(function (thread) {
    const msgs = thread.getMessages();
    const msg = msgs[msgs.length - 1];
    return {
      thread: thread,
      from: msg.getFrom(),
      subject: msg.getSubject() || '(без темы)',
      body: (msg.getPlainBody() || '').slice(0, BODY_CHARS)
    };
  });

  // Классифицируем пачками.
  let notified = 0;
  for (let start = 0; start < items.length; start += BATCH_SIZE) {
    const batch = items.slice(start, start + BATCH_SIZE);
    let verdicts;
    try {
      verdicts = classifyBatch_(batch, c.geminiKey);
    } catch (e) {
      Logger.log('❌ Ошибка классификации пачки: ' + e);
      // Пачку не помечаем разобранной — разберём в следующий раз.
      continue;
    }

    batch.forEach(function (item, i) {
      const v = verdicts[i] || {};
      if (v.is_important) {
        sendTelegram_(c, buildMessage_(item, v));
        notified++;
      }
      item.thread.addLabel(label); // помечаем разобранным (и важное, и неважное)
    });
    Utilities.sleep(400); // мягкая пауза между запросами к API
  }

  Logger.log('Разобрано писем: %s, отправлено в Telegram: %s.', items.length, notified);
}

// ============================================================
//  КЛАССИФИКАЦИЯ ЧЕРЕЗ GEMINI
// ============================================================

/**
 * Отдаёт пачку писем модели одним запросом, возвращает массив вердиктов,
 * выровненный по порядку batch: [{is_important, category, reason}, ...].
 */
function classifyBatch_(batch, apiKey) {
  const listText = batch.map(function (it, i) {
    return '[' + i + ']\n' +
           'From: ' + it.from + '\n' +
           'Subject: ' + it.subject + '\n' +
           'Body (truncated): ' + it.body;
  }).join('\n\n---\n\n');

  const system =
    'Ты — персональный фильтр входящей почты. Для каждого письма реши, требует ли оно ' +
    'личного внимания получателя — то, о чём разумному человеку захотелось бы получить пуш ' +
    'и, возможно, отреагировать. Считай важным (is_important=true):\n' +
    '• работа: вакансии, офферы, обращения рекрутёров, приглашения на собеседование, отклики/' +
    'интерес работодателя, сообщения с job-платформ (hh.ru, LinkedIn, Хабр Карьера);\n' +
    '• личные письма от реального человека, ждущие ответа;\n' +
    '• деньги: счета к оплате, подозрительные списания, возвраты, важные банковские уведомления;\n' +
    '• безопасность: вход в аккаунт, смена пароля, коды 2FA, подозрительная активность;\n' +
    '• сроки: дедлайны, встречи, записи на приём, напоминания к дате;\n' +
    '• прямые срочные запросы, требующие действия; официальные/госуведомления, требующие реакции.\n' +
    'НЕ важным (is_important=false) считай: массовые рассылки, маркетинг и промо, дайджесты и ' +
    'newsletters, уведомления соцсетей (лайки, подписки, упоминания), автоматический шум, рекламу, ' +
    'чеки-подтверждения без требуемого действия. Ставь is_important=true только если реально стоит ' +
    'побеспокоить человека. category — короткая метка: work | personal | finance | security | ' +
    'deadline | urgent | other. reason — одна короткая фраза на русском, почему это важно.';

  const userText =
    'Классифицируй письма ниже. Верни РОВНО по одному результату на письмо, ' +
    'сопоставляя по индексу i (0-based):\n\n' + listText;

  // responseSchema Gemini: типы ЗАГЛАВНЫМИ (OBJECT/ARRAY/STRING/INTEGER/BOOLEAN), без additionalProperties.
  const schema = {
    type: 'OBJECT',
    properties: {
      results: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            i: { type: 'INTEGER' },
            is_important: { type: 'BOOLEAN' },
            category: { type: 'STRING' },
            reason: { type: 'STRING' }
          },
          required: ['i', 'is_important', 'category', 'reason']
        }
      }
    },
    required: ['results']
  };

  const payload = {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };

  const url = GEMINI_BASE + MODEL + ':generateContent';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) {
    throw new Error('Gemini API ' + code + ': ' + text.slice(0, 500));
  }

  const data = JSON.parse(text);
  const cand = (data.candidates || [])[0];
  const parts = cand && cand.content && cand.content.parts;
  if (!parts || !parts.length) {
    throw new Error('Gemini: пустой ответ (' + (cand && cand.finishReason) + '): ' + text.slice(0, 400));
  }
  const outText = parts.map(function (p) { return p.text || ''; }).join('');
  const parsed = JSON.parse(outText);

  // Выравниваем по индексу i на случай, если модель переставит порядок.
  const byIndex = {};
  (parsed.results || []).forEach(function (r) { byIndex[r.i] = r; });
  return batch.map(function (_, i) {
    return byIndex[i] || { is_important: false, category: 'other', reason: 'нет ответа модели' };
  });
}

// ============================================================
//  TELEGRAM
// ============================================================

function emojiFor_(category) {
  const map = {
    work: '💼', personal: '✉️', finance: '💰',
    security: '🔐', deadline: '⏰', urgent: '🚨', other: '🔔'
  };
  return map[category] || '🔔';
}

function buildMessage_(item, verdict) {
  const link = 'https://mail.google.com/mail/u/0/#all/' + item.thread.getId();
  const snippet = (item.body || '').replace(/\s+/g, ' ').slice(0, 300);
  const cat = verdict.category || 'other';
  return emojiFor_(cat) + ' <b>Требует внимания</b> (<i>' + escapeHtml_(cat) + '</i>)\n\n' +
         '<b>Тема:</b> ' + escapeHtml_(item.subject) + '\n' +
         '<b>От:</b> ' + escapeHtml_(item.from) + '\n' +
         '<b>Почему:</b> ' + escapeHtml_(verdict.reason || '') + '\n\n' +
         escapeHtml_(snippet) + '\n\n' +
         '🔗 <a href="' + link + '">Открыть в Gmail</a>';
}

function sendTelegram_(c, htmlText) {
  const url = 'https://api.telegram.org/bot' + c.telegramToken + '/sendMessage';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    payload: JSON.stringify({
      chat_id: c.chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log('⚠️ Telegram ошибка: ' + resp.getContentText().slice(0, 300));
  }
}

// ============================================================
//  ВСПОМОГАТЕЛЬНЫЕ / ОТЛАДКА
// ============================================================

function cfg_() {
  const p = PropertiesService.getScriptProperties();
  return {
    telegramToken: p.getProperty('TELEGRAM_TOKEN'),
    chatId: p.getProperty('TELEGRAM_CHAT_ID'),
    geminiKey: p.getProperty('GEMINI_API_KEY')
  };
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(PROCESSED_LABEL) || GmailApp.createLabel(PROCESSED_LABEL);
}

function escapeHtml_(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Разово: напиши что-нибудь своему боту в Telegram, потом запусти эту функцию —
 * в логах (View → Logs) появятся chat_id. Скопируй нужный в свойство TELEGRAM_CHAT_ID.
 */
function showMyChatId() {
  const token = cfg_().telegramToken;
  if (!token) { Logger.log('Сначала заполни TELEGRAM_TOKEN в Script Properties.'); return; }
  const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) { Logger.log('Ошибка Telegram: ' + resp.getContentText()); return; }
  if (!data.result.length) { Logger.log('Нет апдейтов. Напиши боту любое сообщение и запусти снова.'); return; }
  data.result.forEach(function (u) {
    const chat = (u.message && u.message.chat) || (u.channel_post && u.channel_post.chat);
    if (chat) Logger.log('chat_id=%s  (%s %s / %s)', chat.id, chat.first_name || '', chat.last_name || '', chat.type);
  });
}

/**
 * Разово: проверка, что бот и chat_id настроены — присылает тестовое сообщение.
 */
function sendTestMessage() {
  const c = cfg_();
  if (!c.telegramToken || !c.chatId) { Logger.log('Заполни TELEGRAM_TOKEN и TELEGRAM_CHAT_ID.'); return; }
  sendTelegram_(c, '✅ Тест: бот mail-service подключён и умеет писать сюда.');
  Logger.log('Отправлено. Проверь Telegram.');
}

/**
 * Разово: проверка ключа Gemini — классифицирует одно тестовое «письмо».
 */
function testGemini() {
  const key = cfg_().geminiKey;
  if (!key) { Logger.log('Заполни GEMINI_API_KEY в Script Properties.'); return; }
  const v = classifyBatch_([{
    from: 'HeadHunter <no-reply@hh.ru>',
    subject: 'Ваше резюме заинтересовало работодателя',
    body: 'Здравствуйте! Компания приглашает вас на собеседование.'
  }], key);
  Logger.log('Gemini ответил: %s', JSON.stringify(v[0]));
}
