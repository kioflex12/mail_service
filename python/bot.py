"""
Gmail → Telegram: важные письма с кнопками действий (Python / long-polling).

Мгновенный отклик (без webhook/302), работает на любом всегда-включённом хосте.
Логика повторяет Apps Script-версию:
  • утром (по расписанию) и по /check — проверяет новую почту в Gmail,
    классифицирует письма LLM-моделью через OpenRouter («требует внимания?»),
    важные шлёт в Telegram с кнопками;
  • кнопки под письмом: ✍️ ответ (сгенерировать → апрув → отправить / в черновик /
    переписать), 🧾 саммари, 📅 в календарь, 📥 архив, ✅ прочитано;
  • разобранные письма метятся Gmail-меткой, чтобы не приходить повторно.

Секреты — в .env (см. .env.example). Настройка Google OAuth — в README.md.
"""

import asyncio
import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime, time as dtime
from email.message import EmailMessage
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
)
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

# ===================== Конфиг =====================
load_dotenv()

TELEGRAM_TOKEN = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = int(os.environ["TELEGRAM_CHAT_ID"])
OPENROUTER_API_KEY = os.environ["OPENROUTER_API_KEY"]

DAILY_HOUR = int(os.getenv("DAILY_HOUR", "9"))
TZ = ZoneInfo(os.getenv("TIMEZONE", "Europe/Moscow"))
LOOKBACK_DAYS = int(os.getenv("LOOKBACK_DAYS", "2"))
MAX_THREADS = int(os.getenv("MAX_THREADS", "40"))
GMAIL_QUERY_EXTRA = os.getenv("GMAIL_QUERY_EXTRA", "in:anywhere")
GOOGLE_CREDENTIALS = os.getenv("GOOGLE_CREDENTIALS", "credentials.json")
GOOGLE_TOKEN = os.getenv("GOOGLE_TOKEN", "token.json")

PROCESSED_LABEL = "MailServiceProcessed"
BODY_CHARS = 1500          # тела письма в классификатор
REPLY_BODY_CHARS = 6000    # тела письма в ответ/саммари/календарь
BATCH_SIZE = 20
CHECK_BTN = "🔄 Проверить почту сейчас"

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
# Аварийный список — используется, если не удалось получить актуальный из API OpenRouter.
FALLBACK_MODELS = [
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "openai/gpt-oss-20b:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
]

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",   # чтение, метки, архив, прочитано
    "https://www.googleapis.com/auth/gmail.compose",  # черновики
    "https://www.googleapis.com/auth/gmail.send",     # отправка ответа
    "https://www.googleapis.com/auth/calendar.events",
]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mail-service")

# Черновики ответов между нажатиями кнопок (в памяти процесса).
_drafts: dict[str, dict] = {}
_free_models_cache: dict[str, object] = {"ids": None, "ts": 0.0}

EMOJI = {"work": "💼", "personal": "✉️", "finance": "💰",
         "security": "🔐", "deadline": "⏰", "urgent": "🚨", "other": "🔔"}


# ===================== Google (Gmail + Calendar) =====================

def _google_creds() -> Credentials:
    creds = None
    if os.path.exists(GOOGLE_TOKEN):
        creds = Credentials.from_authorized_user_file(GOOGLE_TOKEN, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(GoogleRequest())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(GOOGLE_CREDENTIALS, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(GOOGLE_TOKEN, "w") as f:
            f.write(creds.to_json())
    return creds


_creds = _google_creds()
gmail = build("gmail", "v1", credentials=_creds, cache_discovery=False)
calendar = build("calendar", "v3", credentials=_creds, cache_discovery=False)


def _ensure_label() -> str:
    labels = gmail.users().labels().list(userId="me").execute().get("labels", [])
    for lb in labels:
        if lb["name"] == PROCESSED_LABEL:
            return lb["id"]
    created = gmail.users().labels().create(
        userId="me", body={"name": PROCESSED_LABEL}).execute()
    return created["id"]


def _header(msg, name):
    for h in msg.get("payload", {}).get("headers", []):
        if h["name"].lower() == name.lower():
            return h["value"]
    return ""


def _plain_body(msg) -> str:
    """Извлекает текст письма (text/plain, иначе fallback на snippet)."""
    def walk(part):
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", "replace")
        for p in part.get("parts", []) or []:
            r = walk(p)
            if r:
                return r
        return ""
    body = walk(msg.get("payload", {}))
    return body or msg.get("snippet", "")


def fetch_candidates():
    """Треды за LOOKBACK_DAYS без метки PROCESSED — берём последнее сообщение каждого."""
    label_id = _ensure_label()
    q = f"newer_than:{LOOKBACK_DAYS}d -label:{PROCESSED_LABEL}"
    if GMAIL_QUERY_EXTRA:
        q += f" {GMAIL_QUERY_EXTRA}"
    resp = gmail.users().threads().list(userId="me", q=q, maxResults=MAX_THREADS).execute()
    items = []
    for th in resp.get("threads", []):
        thread = gmail.users().threads().get(userId="me", id=th["id"], format="full").execute()
        msgs = thread.get("messages", [])
        if not msgs:
            continue
        m = msgs[-1]
        items.append({
            "threadId": th["id"],
            "from": _header(m, "From"),
            "subject": _header(m, "Subject") or "(без темы)",
            "body": _plain_body(m)[:BODY_CHARS],
        })
    return items, label_id


def email_from_thread(thread_id: str) -> dict:
    thread = gmail.users().threads().get(userId="me", id=thread_id, format="full").execute()
    m = thread["messages"][-1]
    return {
        "from": _header(m, "From"),
        "subject": _header(m, "Subject") or "(без темы)",
        "body": _plain_body(m)[:REPLY_BODY_CHARS],
        "message_id": _header(m, "Message-ID"),
        "references": _header(m, "References"),
    }


def gmail_archive(thread_id):
    for m in gmail.users().threads().get(userId="me", id=thread_id).execute()["messages"]:
        gmail.users().messages().modify(
            userId="me", id=m["id"], body={"removeLabelIds": ["INBOX"]}).execute()


def gmail_mark_read(thread_id):
    for m in gmail.users().threads().get(userId="me", id=thread_id).execute()["messages"]:
        gmail.users().messages().modify(
            userId="me", id=m["id"], body={"removeLabelIds": ["UNREAD"]}).execute()


def gmail_add_processed(thread_id, label_id):
    gmail.users().threads().modify(
        userId="me", id=thread_id, body={"addLabelIds": [label_id]}).execute()


def _build_reply_mime(email: dict, text: str) -> dict:
    msg = EmailMessage()
    to_addr = email["from"]
    subj = email["subject"]
    msg["To"] = to_addr
    msg["Subject"] = subj if subj.lower().startswith("re:") else f"Re: {subj}"
    if email.get("message_id"):
        msg["In-Reply-To"] = email["message_id"]
        refs = (email.get("references", "") + " " + email["message_id"]).strip()
        msg["References"] = refs
    msg.set_content(text)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw}


def gmail_send_reply(thread_id, email, text):
    body = _build_reply_mime(email, text)
    body["threadId"] = thread_id
    gmail.users().messages().send(userId="me", body=body).execute()


def gmail_create_draft(thread_id, email, text):
    body = _build_reply_mime(email, text)
    body["threadId"] = thread_id
    gmail.users().drafts().create(userId="me", body={"message": body}).execute()


def calendar_create(title, start: datetime, end: datetime, location, description):
    calendar.events().insert(calendarId="primary", body={
        "summary": title,
        "location": location or "",
        "description": description or "",
        "start": {"dateTime": start.isoformat(), "timeZone": str(TZ)},
        "end": {"dateTime": end.isoformat(), "timeZone": str(TZ)},
    }).execute()


# ===================== OpenRouter LLM =====================

async def _free_models(client: httpx.AsyncClient) -> list[str]:
    import time as _t
    if _free_models_cache["ids"] and _t.time() - _free_models_cache["ts"] < 21600:
        return _free_models_cache["ids"]
    try:
        r = await client.get("https://openrouter.ai/api/v1/models", timeout=20)
        data = r.json().get("data", [])
        ids = [m["id"] for m in data
               if str(m["id"]).endswith(":free")
               and float(m.get("pricing", {}).get("prompt", 0) or 0) == 0
               and float(m.get("pricing", {}).get("completion", 0) or 0) == 0]
        prefer = ["qwen3-next", "gpt-oss", "gemma-4", "gemma", "llama-3.3",
                  "nemotron-3-super", "hermes", "mistral", "deepseek", "qwen"]
        avoid = re.compile(r"coder|vision|-vl|safety|guard|embed|reasoning|tts|whisper|image", re.I)
        good = [i for i in ids if not avoid.search(i)]
        good.sort(key=lambda i: next((n for n, p in enumerate(prefer) if p in i), len(prefer)))
        ordered = good[:8]
        if ordered:
            _free_models_cache["ids"] = ordered
            _free_models_cache["ts"] = _t.time()
            return ordered
    except Exception as e:
        log.warning("free_models fetch failed: %s", e)
    return FALLBACK_MODELS


async def or_complete(system: str, user: str, temperature: float = 0.0) -> str:
    async with httpx.AsyncClient() as client:
        models = await _free_models(client)
        last = ""
        for model in models:
            for attempt in range(2):
                try:
                    r = await client.post(
                        OPENROUTER_URL,
                        headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}",
                                 "X-Title": "mail-service"},
                        json={"model": model, "temperature": temperature,
                              "messages": [{"role": "system", "content": system},
                                           {"role": "user", "content": user}]},
                        timeout=60,
                    )
                except Exception as e:
                    last = f"{model}: {e}"
                    break
                if r.status_code == 200:
                    content = (r.json().get("choices", [{}])[0]
                               .get("message", {}).get("content", "") or "").strip()
                    if content:
                        return content
                    last = f"{model}: empty"
                    break
                if r.status_code == 429 or r.status_code >= 500:
                    last = f"{model}: {r.status_code}"
                    ra = 1.5
                    try:
                        ra = float(r.json()["error"]["metadata"]["retry_after_seconds"])
                    except Exception:
                        pass
                    if attempt == 0 and ra <= 8:
                        await asyncio.sleep(ra)
                        continue
                    break
                last = f"{model}: {r.status_code} {r.text[:120]}"
                break
        raise RuntimeError(f"OpenRouter: не ответила ни одна из бесплатных моделей. {last}")


def _extract_json(text: str):
    s, e = text.find("{"), text.rfind("}")
    if s < 0 or e <= s:
        return None
    try:
        return json.loads(text[s:e + 1])
    except Exception:
        return None


async def classify_batch(batch: list[dict]) -> list[dict]:
    listing = "\n\n---\n\n".join(
        f"[{i}]\nFrom: {it['from']}\nSubject: {it['subject']}\nBody (truncated): {it['body']}"
        for i, it in enumerate(batch))
    system = (
        "Ты — персональный фильтр входящей почты. Для каждого письма реши, требует ли оно "
        "личного внимания получателя. Считай важным (is_important=true):\n"
        "• работа: вакансии, офферы, рекрутёры, приглашения на собеседование, отклики, job-платформы (hh.ru, LinkedIn);\n"
        "• личные письма от реального человека, ждущие ответа;\n"
        "• деньги: счета, подозрительные списания, возвраты, важные банковские уведомления;\n"
        "• безопасность: вход в аккаунт, смена пароля, 2FA, подозрительная активность;\n"
        "• сроки: дедлайны, встречи, записи, напоминания к дате;\n"
        "• срочные запросы, требующие действия; официальные/госуведомления.\n"
        "НЕ важным считай: рассылки, маркетинг/промо, дайджесты, соцсети-уведомления, автошум, рекламу, "
        "чеки без требуемого действия. Ставь is_important=true только если реально стоит побеспокоить.\n\n"
        "Ответь ТОЛЬКО валидным JSON, без markdown, ровно по одному объекту на письмо: "
        '{"results":[{"i":<int>,"is_important":<bool>,'
        '"category":"<work|personal|finance|security|deadline|urgent|other>","reason":"<фраза на русском>"}]}')
    out = await or_complete(system, "Классифицируй письма (по индексу i, 0-based):\n\n" + listing, 0.0)
    parsed = _extract_json(out) or {}
    by_i = {r["i"]: r for r in parsed.get("results", [])}
    return [by_i.get(i, {"is_important": False, "category": "other", "reason": "нет ответа модели"})
            for i in range(len(batch))]


async def generate_reply(email: dict, prev_draft: str | None, instructions: str | None) -> str:
    system = ("Ты пишешь ответ на письмо от лица получателя. Пиши на языке письма, вежливо и по делу, "
              "без выдуманных фактов. Верни ТОЛЬКО текст ответа — без темы, без «From/To», без пояснений. "
              "Не придумывай имя/подпись, если их нет в контексте.")
    user = f"Письмо, на которое отвечаем:\nFrom: {email['from']}\nSubject: {email['subject']}\n\n{email['body']}"
    if prev_draft:
        user += (f"\n\n---\nТвой предыдущий черновик:\n{prev_draft}"
                 f"\n\n---\nПоправь с учётом пожеланий: {instructions or ''}")
    return await or_complete(system, user, 0.4)


async def summarize(email: dict) -> str:
    return await or_complete(
        "Сожми письмо в 2–4 коротких пункта на русском. Только пункты списком, без вступления.",
        f"From: {email['from']}\nSubject: {email['subject']}\n\n{email['body']}", 0.2)


async def extract_event(email: dict):
    today = datetime.now(TZ).strftime("%Y-%m-%d")
    system = ('Извлеки из письма событие (встреча, дедлайн, запись, созвон). Ответь ТОЛЬКО JSON без markdown: '
              '{"has_event":<bool>,"title":"<кратко>","start":"YYYY-MM-DD HH:mm",'
              '"end":"YYYY-MM-DD HH:mm или пусто","location":"<или пусто>"}. Если явной даты/времени нет — '
              'has_event=false. Год по умолчанию текущий, время по умолчанию 10:00.')
    user = f"Сегодня: {today}\nFrom: {email['from']}\nSubject: {email['subject']}\n\n{email['body']}"
    return _extract_json(await or_complete(system, user, 0.0))


def _parse_local(s: str):
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", str(s))
    if not m:
        return None
    return datetime(*(int(x) for x in m.groups()), tzinfo=TZ)


# ===================== Telegram: клавиатуры и сообщения =====================

def action_kb(thread_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✍️ Ответ", callback_data=f"gen:{thread_id}"),
         InlineKeyboardButton("🧾 Саммари", callback_data=f"summ:{thread_id}")],
        [InlineKeyboardButton("📅 В календарь", callback_data=f"cal:{thread_id}")],
        [InlineKeyboardButton("📥 Архив", callback_data=f"arch:{thread_id}"),
         InlineKeyboardButton("✅ Прочитано", callback_data=f"read:{thread_id}")],
    ])


def draft_kb(draft_id):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Отправить", callback_data=f"send:{draft_id}")],
        [InlineKeyboardButton("📝 В черновик Gmail", callback_data=f"gdraft:{draft_id}"),
         InlineKeyboardButton("✏️ Переписать", callback_data=f"redo:{draft_id}")],
        [InlineKeyboardButton("✖ Отмена", callback_data=f"cancel:{draft_id}")],
    ])


def main_kb():
    return ReplyKeyboardMarkup([[KeyboardButton(CHECK_BTN)]],
                               resize_keyboard=True, is_persistent=True)


def esc(s):
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def build_card(item, verdict) -> str:
    link = f"https://mail.google.com/mail/u/0/#all/{item['threadId']}"
    snippet = re.sub(r"\s+", " ", item["body"])[:300]
    cat = verdict.get("category", "other")
    return (f"{EMOJI.get(cat, '🔔')} <b>Требует внимания</b> (<i>{esc(cat)}</i>)\n\n"
            f"<b>Тема:</b> {esc(item['subject'])}\n"
            f"<b>От:</b> {esc(item['from'])}\n"
            f"<b>Почему:</b> {esc(verdict.get('reason', ''))}\n\n"
            f"{esc(snippet)}\n\n"
            f'🔗 <a href="{link}">Открыть в Gmail</a>')


# ===================== Ядро: проверка почты =====================

async def check_important_mail(context: ContextTypes.DEFAULT_TYPE) -> dict:
    items, label_id = await asyncio.to_thread(fetch_candidates)
    if not items:
        return {"scanned": 0, "notified": 0}
    notified = 0
    for start in range(0, len(items), BATCH_SIZE):
        batch = items[start:start + BATCH_SIZE]
        try:
            verdicts = await classify_batch(batch)
        except Exception as e:
            log.error("classify error: %s", e)
            continue
        for item, v in zip(batch, verdicts):
            if v.get("is_important"):
                await context.bot.send_message(
                    CHAT_ID, build_card(item, v), parse_mode=ParseMode.HTML,
                    disable_web_page_preview=True, reply_markup=action_kb(item["threadId"]))
                notified += 1
            await asyncio.to_thread(gmail_add_processed, item["threadId"], label_id)
    return {"scanned": len(items), "notified": notified}


async def daily_check(context: ContextTypes.DEFAULT_TYPE):
    r = await check_important_mail(context)
    log.info("daily: scanned=%s notified=%s", r["scanned"], r["notified"])


# ===================== Хендлеры =====================

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.id != CHAT_ID:
        return
    await update.message.reply_text(
        "Привет! Я присылаю важные письма из Gmail с кнопками действий. Работаю по расписанию (~9:00), "
        "а кнопкой ниже (или /check) можно проверить вручную.",
        reply_markup=main_kb())


async def cmd_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.id != CHAT_ID:
        return
    await update.message.reply_text("🔄 Принял, проверяю почту…")
    r = await check_important_mail(context)
    await context.bot.send_message(
        CHAT_ID,
        "📭 Новых писем нет." if r["scanned"] == 0
        else f"✅ Готово: разобрано {r['scanned']}, важных {r['notified']}.")


async def on_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat.id != CHAT_ID:
        return
    text = (update.message.text or "").strip()
    if text == CHECK_BTN:
        await cmd_check(update, context)
        return
    # Ждём правку черновика?
    draft_id = context.user_data.pop("await_edit", None)
    if draft_id and draft_id in _drafts:
        st = _drafts[draft_id]
        email = await asyncio.to_thread(email_from_thread, st["threadId"])
        msg = await update.message.reply_text("✍️ Переписываю…")
        try:
            st["draft"] = await generate_reply(email, st["draft"], text)
        except Exception as e:
            await msg.edit_text(f"⚠️ Не получилось: {e}")
            return
        await msg.edit_text(f"✍️ Обновлённый черновик:\n\n{st['draft']}", reply_markup=draft_kb(draft_id))


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.callback_query
    if q.message.chat.id != CHAT_ID:
        await q.answer()
        return
    action, _, arg = q.data.partition(":")
    toast = {"gen": "⏳ Секунду…", "summ": "⏳ Секунду…", "cal": "⏳ Секунду…",
             "read": "✅ Прочитано", "arch": "📥 В архиве"}.get(action, "")
    await q.answer(toast)
    try:
        if action == "read":
            await q.message.delete()
            await asyncio.to_thread(gmail_mark_read, arg)
        elif action == "arch":
            await q.message.delete()
            await asyncio.to_thread(gmail_archive, arg)
        elif action == "gen":
            await on_generate(context, arg)
        elif action == "summ":
            await on_summary(context, arg)
        elif action == "cal":
            await on_calendar(context, arg)
        elif action == "send":
            await on_send(context, arg)
        elif action == "gdraft":
            await on_save_draft(context, arg)
        elif action == "redo":
            _drafts.get(arg) and context.user_data.__setitem__("await_edit", arg)
            await context.bot.send_message(CHAT_ID, "✏️ Пришли одним сообщением, что поправить в ответе.")
        elif action == "cancel":
            _drafts.pop(arg, None)
            await context.bot.send_message(CHAT_ID, "✖ Отменено.")
    except Exception as e:
        log.error("callback %s error: %s", action, e)
        await context.bot.send_message(CHAT_ID, f"⚠️ Не получилось: {e}")


async def on_generate(context, thread_id):
    email = await asyncio.to_thread(email_from_thread, thread_id)
    msg = await context.bot.send_message(CHAT_ID, "✍️ Пишу ответ…")
    draft = await generate_reply(email, None, None)
    draft_id = uuid.uuid4().hex
    _drafts[draft_id] = {"threadId": thread_id, "draft": draft, "email": email}
    await msg.edit_text(f"✍️ Черновик ответа (тема: {email['subject']}):\n\n{draft}",
                        reply_markup=draft_kb(draft_id))


async def on_summary(context, thread_id):
    email = await asyncio.to_thread(email_from_thread, thread_id)
    msg = await context.bot.send_message(CHAT_ID, "🧾 Готовлю саммари…")
    await msg.edit_text("🧾 Кратко:\n\n" + await summarize(email))


async def on_calendar(context, thread_id):
    email = await asyncio.to_thread(email_from_thread, thread_id)
    msg = await context.bot.send_message(CHAT_ID, "📅 Ищу дату в письме…")
    ev = await extract_event(email)
    if not ev or not ev.get("has_event") or not ev.get("start"):
        await msg.edit_text("📅 Явной даты в письме не нашёл — событие не создал.")
        return
    start = _parse_local(ev["start"])
    if not start:
        await msg.edit_text(f"📅 Не смог разобрать дату («{ev['start']}»).")
        return
    from datetime import timedelta
    end = _parse_local(ev.get("end") or "") or (start + timedelta(hours=1))
    title = ev.get("title") or email["subject"]
    await asyncio.to_thread(calendar_create, title, start, end, ev.get("location"),
                            f"Из письма: {email['subject']}\n{email['from']}")
    await msg.edit_text(f"📅 Событие создано: «{title}» — {start.strftime('%d.%m.%Y %H:%M')}")


async def on_send(context, draft_id):
    st = _drafts.get(draft_id)
    if not st:
        await context.bot.send_message(CHAT_ID, "Черновик устарел, сгенерируй заново.")
        return
    await asyncio.to_thread(gmail_send_reply, st["threadId"], st["email"], st["draft"])
    _drafts.pop(draft_id, None)
    await context.bot.send_message(CHAT_ID, "✅ Ответ отправлен.")


async def on_save_draft(context, draft_id):
    st = _drafts.get(draft_id)
    if not st:
        await context.bot.send_message(CHAT_ID, "Черновик устарел, сгенерируй заново.")
        return
    await asyncio.to_thread(gmail_create_draft, st["threadId"], st["email"], st["draft"])
    _drafts.pop(draft_id, None)
    await context.bot.send_message(CHAT_ID, "📝 Черновик сохранён в Gmail — правь и отправляй из почты.")


# ===================== Запуск =====================

def main():
    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("check", cmd_check))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.job_queue.run_daily(daily_check, time=dtime(hour=DAILY_HOUR, minute=0, tzinfo=TZ))
    log.info("mail-service запущен (long-polling). Ежедневная проверка в %02d:00 %s.", DAILY_HOUR, TZ)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
