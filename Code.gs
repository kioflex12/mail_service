/**
 * Gmail → Telegram job-alert.
 *
 * Каждое утро проверяет новые письма в Gmail, классифицирует их моделью Claude
 * («это про работу — вакансия/оффер/рекрутёр/приглашение или нет») и присылает
 * найденное в Telegram-бота.
 *
 * Секреты хранятся в Script Properties (Project Settings → Script properties),
 * НЕ в коде:
 *   TELEGRAM_TOKEN      — токен бота от @BotFather
 *   TELEGRAM_CHAT_ID    — id чата, куда слать (см. showMyChatId ниже)
 *   ANTHROPIC_API_KEY   — ключ Claude API
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
const PROCESSED_LABEL = 'JobAlertProcessed'; // метка, которой помечаем разобранные письма (защита от повторов)
const SEARCH_QUERY_EXTRA = 'in:anywhere'; // где искать: in:anywhere = вся почта. Можно сузить до 'in:inbox' или 'category:primary'.

// Модель-классификатор. Haiku 4.5 — дёшево и быстро для задачи «да/нет про работу».
// Хочешь максимум качества — поставь 'claude-opus-4-8' или 'claude-sonnet-5' (дороже).
const MODEL = 'claude-haiku-4-5';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

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
  if (!c.anthropicKey)  missing.push('ANTHROPIC_API_KEY');
  if (missing.length) {
    throw new Error('Не заполнены Script Properties: ' + missing.join(', ') +
      '. Project Settings → Script properties, затем запусти setup() снова.');
  }

  // Убираем старые триггеры этой функции, чтобы не плодить дубли.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkJobEmails') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('checkJobEmails')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_HOUR)
    .create();

  getOrCreateLabel_(); // создаём метку заранее
  Logger.log('✅ Готово. Ежедневный триггер checkJobEmails поставлен на ~%s:00 (Europe/Moscow).', DAILY_HOUR);
  Logger.log('Проверить прямо сейчас можно, запустив checkJobEmails вручную.');
}

// ============================================================
//  ОСНОВНАЯ ЛОГИКА (её дёргает триггер каждое утро)
// ============================================================

function checkJobEmails() {
  const c = cfg_();
  if (!c.telegramToken || !c.chatId || !c.anthropicKey) {
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
      verdicts = classifyBatch_(batch, c.anthropicKey);
    } catch (e) {
      Logger.log('❌ Ошибка классификации пачки: ' + e);
      // Пачку не помечаем разобранной — разберём в следующий раз.
      continue;
    }

    batch.forEach(function (item, i) {
      const v = verdicts[i] || {};
      if (v.is_job) {
        sendTelegram_(c, buildMessage_(item, v));
        notified++;
      }
      item.thread.addLabel(label); // помечаем разобранным (и работу, и не-работу)
    });
    Utilities.sleep(300); // мягкая пауза между запросами к API
  }

  Logger.log('Разобрано писем: %s, отправлено в Telegram: %s.', items.length, notified);
}

// ============================================================
//  КЛАССИФИКАЦИЯ ЧЕРЕЗ CLAUDE
// ============================================================

/**
 * Отдаёт пачку писем модели одним запросом, возвращает массив вердиктов,
 * выровненный по порядку batch: [{is_job, category, reason}, ...].
 */
function classifyBatch_(batch, apiKey) {
  const listText = batch.map(function (it, i) {
    return '[' + i + ']\n' +
           'From: ' + it.from + '\n' +
           'Subject: ' + it.subject + '\n' +
           'Body (truncated): ' + it.body;
  }).join('\n\n---\n\n');

  const system =
    'Ты классифицируешь письма. Для каждого письма реши, является ли оно настоящей ' +
    'возможностью по работе для получателя как кандидата: вакансия, оффер, обращение ' +
    'рекрутёра, приглашение на собеседование/интервью, отклик или интерес работодателя, ' +
    'сообщение с job-платформ (HeadHunter/hh.ru, LinkedIn, Хабр Карьера и т.п.) о конкретной ' +
    'возможности. НЕ считаются работой: обычные рассылки и маркетинг, дайджесты вакансий без ' +
    'конкретной релевантности, уведомления не про найм, чеки/счета, соцсети, системные ' +
    'автописьма. Ставь is_job=true только если разумному соискателю захотелось бы получить ' +
    'пуш об этом письме. Отвечай на русском в поле reason (кратко, одна фраза).';

  const userText =
    'Классифицируй письма ниже. Верни РОВНО по одному результату на письмо, ' +
    'сопоставляя по индексу i (0-based):\n\n' + listText;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['i', 'is_job', 'category', 'reason'],
          properties: {
            i: { type: 'integer' },
            is_job: { type: 'boolean' },
            category: { type: 'string' }, // vacancy | recruiter | offer | interview | hh_response | other
            reason: { type: 'string' }
          }
        }
      }
    }
  };

  const payload = {
    model: MODEL,
    max_tokens: 2048,
    system: system,
    output_config: { format: { type: 'json_schema', schema: schema } },
    messages: [{ role: 'user', content: userText }]
  };

  const resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    muteHttpExceptions: true,
    payload: JSON.stringify(payload)
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code !== 200) {
    throw new Error('Anthropic API ' + code + ': ' + text.slice(0, 500));
  }

  const data = JSON.parse(text);
  const outText = (data.content || [])
    .filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; })
    .join('');
  const parsed = JSON.parse(outText);

  // Выравниваем по индексу i на случай, если модель переставит порядок.
  const byIndex = {};
  (parsed.results || []).forEach(function (r) { byIndex[r.i] = r; });
  return batch.map(function (_, i) {
    return byIndex[i] || { is_job: false, category: 'other', reason: 'нет ответа модели' };
  });
}

// ============================================================
//  TELEGRAM
// ============================================================

function buildMessage_(item, verdict) {
  const link = 'https://mail.google.com/mail/u/0/#all/' + item.thread.getId();
  const snippet = (item.body || '').replace(/\s+/g, ' ').slice(0, 300);
  return '💼 <b>Похоже на работу</b> (<i>' + escapeHtml_(verdict.category || 'other') + '</i>)\n\n' +
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
    anthropicKey: p.getProperty('ANTHROPIC_API_KEY')
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
  sendTelegram_(c, '✅ Тест: бот job-alert подключён и умеет писать сюда.');
  Logger.log('Отправлено. Проверь Telegram.');
}
