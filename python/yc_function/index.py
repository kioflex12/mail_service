"""Yandex Cloud Function: VK-бот важных писем (serverless, Callback API + таймер).

Один вход `handler(event, context)`:
  • HTTP-вызов (публичный URL функции = адрес сервера VK Callback API) → обработка события;
  • Timer-триггер (ежедневно ~9:00) → проверка почты.

VK выбран вместо Telegram потому, что из РФ-облака Yandex Telegram недостижим в обе стороны;
VK — российский сервис, доступен. Меняется ТОЛЬКО транспорт: доменная логика переиспользуется
из пакета mail_service (gmail/analysis/llm/models) как есть.

Состояние (черновики ответов, ожидание правки, дедуп событий) хранится в Object Storage (S3).

ENV:
  VK_GROUP_TOKEN, VK_USER_ID, VK_CONFIRMATION, VK_SECRET, OPENROUTER_API_KEY,
  GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
  STATE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
  TIMEZONE=Europe/Moscow, LOOKBACK_DAYS=2, MAX_THREADS=40, GMAIL_QUERY_EXTRA=in:anywhere
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import random
import re
import uuid
from datetime import timedelta
from zoneinfo import ZoneInfo

import boto3
import httpx
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials

from mail_service.analysis import MailAnalyzer
from mail_service.calendar_client import CalendarClient
from mail_service.gmail import GmailClient
from mail_service.llm import OpenRouterClient
from mail_service.models import Email

# ===================== конфиг =====================
VK_GROUP_TOKEN = os.environ["VK_GROUP_TOKEN"]
USER_ID = int(os.environ["VK_USER_ID"])          # получатель = владелец бота
VK_CONFIRMATION = os.environ.get("VK_CONFIRMATION", "")
VK_SECRET = os.environ.get("VK_SECRET", "")
OPENROUTER_KEY = os.environ["OPENROUTER_API_KEY"]
STATE_BUCKET = os.environ["STATE_BUCKET"]
TZ = ZoneInfo(os.environ.get("TIMEZONE", "Europe/Moscow"))
LOOKBACK_DAYS = int(os.environ.get("LOOKBACK_DAYS", "2"))
MAX_THREADS = int(os.environ.get("MAX_THREADS", "40"))
GMAIL_QUERY_EXTRA = os.environ.get("GMAIL_QUERY_EXTRA", "in:anywhere")

VK_API_VERSION = "5.199"
CHECK_BUTTON = "🔄 Проверить почту сейчас"
_GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
]
_EMOJI = {"work": "💼", "personal": "✉️", "finance": "💰",
          "security": "🔐", "deadline": "⏰", "urgent": "🚨", "other": "🔔"}

_VK = httpx.Client(base_url="https://api.vk.com/method", timeout=60)
_S3 = boto3.client("s3", endpoint_url="https://storage.yandexcloud.net", region_name="ru-central1")


# ===================== Google-клиенты (creds из refresh_token) =====================

def _build_clients() -> tuple[GmailClient, CalendarClient]:
    creds = Credentials(
        token=None,
        refresh_token=os.environ["GMAIL_REFRESH_TOKEN"],
        client_id=os.environ["GMAIL_CLIENT_ID"],
        client_secret=os.environ["GMAIL_CLIENT_SECRET"],
        token_uri="https://oauth2.googleapis.com/token",
        scopes=_GMAIL_SCOPES,
    )
    creds.refresh(GoogleRequest())
    return GmailClient(creds), CalendarClient(creds, TZ)


# ===================== состояние (Object Storage) =====================

def _state_get(key: str) -> dict | None:
    try:
        obj = _S3.get_object(Bucket=STATE_BUCKET, Key=key)
        return json.loads(obj["Body"].read())
    except _S3.exceptions.NoSuchKey:
        return None
    except Exception:
        return None


def _state_put(key: str, value: dict) -> None:
    _S3.put_object(Bucket=STATE_BUCKET, Key=key, Body=json.dumps(value).encode())


def _state_del(key: str) -> None:
    try:
        _S3.delete_object(Bucket=STATE_BUCKET, Key=key)
    except Exception:
        pass


def _email_to_dict(e: Email) -> dict:
    return {"thread_id": e.thread_id, "sender": e.sender, "subject": e.subject,
            "body": e.body, "message_id": e.message_id, "references": e.references}


def _email_from_dict(d: dict) -> Email:
    return Email(**d)


# ===================== LLM (через переиспользуемый MailAnalyzer) =====================

def _analyzer_run(coro_factory):
    """Каждый вызов — свежий OpenRouterClient в новом event-loop (serverless-safe)."""
    async def _run():
        # Таймаут короче дефолтного (60с): в serverless на бесплатных моделях лучше быстро
        # уйти к следующей модели, чем висеть до 300с-таймаута функции.
        llm = OpenRouterClient(OPENROUTER_KEY, request_timeout=30)
        try:
            return await coro_factory(MailAnalyzer(llm, TZ))
        finally:
            await llm.aclose()
    return asyncio.run(_run())


# ===================== VK API =====================
# Отличия от Telegram, важные для этого файла:
#   • нет HTML/markdown в тексте сообщений — карточка идёт plain-text, ссылка кликается сама;
#   • messages.send требует random_id (антидубль на стороне VK) и возвращает глобальный message_id;
#   • клик по кнопке (message_event) даёт conversation_message_id (cmid), а не глобальный id —
#     поэтому наши плейсхолдеры правим по message_id из send, а карточку удаляем по cmid из клика;
#   • редактирование/удаление своих сообщений VK разрешает только ~24 ч (аналог 48ч Telegram).

def _vk(method: str, **params) -> dict:
    params["access_token"] = VK_GROUP_TOKEN
    params["v"] = VK_API_VERSION
    resp = _VK.post(f"/{method}", data=params)
    data = resp.json()
    # Ошибки VK API раньше молча терялись — теперь видно причину (напр. нет прав, закрыты ЛС).
    if isinstance(data, dict) and data.get("error"):
        print(f"[vk-error] {method}: {data['error']}", flush=True)
    return data


def _send(text: str, *, keyboard: dict | None = None) -> int | None:
    """Шлёт сообщение владельцу, возвращает глобальный message_id (или None при ошибке)."""
    p: dict = {"user_id": USER_ID, "message": text[:4000],
               "random_id": random.getrandbits(31), "dont_parse_links": 1}
    if keyboard is not None:
        p["keyboard"] = json.dumps(keyboard, ensure_ascii=False)
    r = _vk("messages.send", **p)
    resp = r.get("response")
    return resp if isinstance(resp, int) else None


def _edit(message_id: int, text: str, *, keyboard: dict | None = None) -> None:
    """Правит наш плейсхолдер по глобальному message_id (полученному из _send)."""
    p: dict = {"peer_id": USER_ID, "message_id": message_id,
               "message": text[:4000], "dont_parse_links": 1}
    if keyboard is not None:
        p["keyboard"] = json.dumps(keyboard, ensure_ascii=False)
    _vk("messages.edit", **p)


def _answer_event(event_id: str, peer_id: int | None, text: str = "") -> None:
    """Аналог answerCallbackQuery: гасит «часики» на кнопке, опционально показывает всплывашку."""
    data: dict = {"event_id": event_id, "user_id": USER_ID, "peer_id": peer_id}
    if text:
        data["event_data"] = json.dumps({"type": "show_snackbar", "text": text}, ensure_ascii=False)
    _vk("messages.sendMessageEventAnswer", **data)


def _btn(label: str, action: str, arg: str, color: str = "secondary") -> dict:
    return {"action": {"type": "callback", "label": label,
                       "payload": json.dumps({"a": action, "v": arg}, ensure_ascii=False)},
            "color": color}


def _action_kb(thread_id: str) -> dict:
    return {"inline": True, "buttons": [
        [_btn("✍️ Ответ", "gen", thread_id, "primary"), _btn("🧾 Саммари", "summ", thread_id)],
        [_btn("📅 В календарь", "cal", thread_id)],
        [_btn("📥 Архив", "arch", thread_id), _btn("✅ Прочитано", "read", thread_id, "positive")],
    ]}


def _draft_kb(draft_id: str) -> dict:
    return {"inline": True, "buttons": [
        [_btn("✅ Отправить", "send", draft_id, "positive")],
        [_btn("📝 В черновик Gmail", "gdraft", draft_id), _btn("✏️ Переписать", "redo", draft_id)],
        [_btn("✖ Отмена", "cancel", draft_id, "negative")],
    ]}


def _delete_kb() -> dict:
    return {"inline": True, "buttons": [[_btn("🗑 Удалить", "del", "", "negative")]]}


def _main_kb() -> dict:
    return {"one_time": False, "buttons": [
        [{"action": {"type": "text", "label": CHECK_BUTTON}, "color": "primary"}]]}


def _card(email: Email, verdict) -> str:
    link = f"https://mail.google.com/mail/u/0/#all/{email.thread_id}"
    snippet = re.sub(r"\s+", " ", email.body)[:300]
    cat = verdict.category
    return (f"{_EMOJI.get(cat, '🔔')} Требует внимания ({cat})\n\n"
            f"Тема: {email.subject}\n"
            f"От: {email.sender}\n"
            f"Почему: {verdict.reason}\n\n"
            f"{snippet}\n\n"
            f"🔗 Открыть в Gmail: {link}")


# ===================== проверка почты =====================

def check_mail() -> tuple[int, int]:
    gmail, _ = _build_clients()
    emails = gmail.search_unprocessed(
        lookback_days=LOOKBACK_DAYS, extra_query=GMAIL_QUERY_EXTRA, max_threads=MAX_THREADS)
    print(f"[check] найдено писем: {len(emails)}", flush=True)
    if not emails:
        return 0, 0
    verdicts = _analyzer_run(lambda a: a.classify(emails))
    print(f"[check] классификация готова: важных {sum(v.is_important for v in verdicts)}", flush=True)
    notified = 0
    for email, verdict in zip(emails, verdicts):
        if verdict.is_important:
            _send(_card(email, verdict), keyboard=_action_kb(email.thread_id))
            notified += 1
        gmail.mark_processed(email.thread_id)
    return len(emails), notified


# ===================== обработка событий =====================

def handle_message(msg: dict) -> None:
    from_id = msg.get("from_id")
    text = (msg.get("text") or "").strip()
    print(f"[msg] from_id={from_id} text={text!r}", flush=True)
    if from_id != USER_ID:
        print(f"[msg] игнор: from_id {from_id} != USER_ID {USER_ID}", flush=True)
        return

    if text in ("/check", CHECK_BUTTON):
        _send("🔄 Принял, проверяю почту…")
        try:
            scanned, notified = check_mail()
        except Exception as exc:  # noqa: BLE001 — показываем сбой пользователю, а не молчим
            print(f"[check-error] {exc!r}", flush=True)
            _send(f"⚠️ Проверка не удалась: {exc}")
            return
        _send("📭 Новых писем нет." if scanned == 0
              else f"✅ Готово: разобрано {scanned}, важных {notified}.")
        return

    # Ожидание правки черновика: свободный текст = пожелания «как переписать».
    edit_key = f"edit/{USER_ID}"
    pending = _state_get(edit_key)
    if pending and (draft := _state_get(f"drafts/{pending['draft_id']}.json")):
        _state_del(edit_key)
        email = _email_from_dict(draft["email"])
        mid = _send("✍️ Переписываю…")
        new_text = _analyzer_run(lambda a: a.generate_reply(email, draft["text"], text))
        draft["text"] = new_text
        _state_put(f"drafts/{pending['draft_id']}.json", draft)
        if mid:
            _edit(mid, f"✍️ Обновлённый черновик:\n\n{new_text}", keyboard=_draft_kb(pending["draft_id"]))
        return

    # Любое другое сообщение (/start, «старт», «Начать», приветствие, что угодно) — показываем
    # меню с кнопкой. Так владелец никогда не остаётся без ответа из-за «не того» слова.
    _send("Привет! Я присылаю важные письма из Gmail с кнопками действий. Работаю по "
          "расписанию (~9:00), а кнопкой ниже (или /check) можно проверить вручную.",
          keyboard=_main_kb())


def handle_callback(obj: dict) -> None:
    peer_id = obj.get("peer_id")
    event_id = obj.get("event_id") or ""
    if obj.get("user_id") != USER_ID:
        _answer_event(event_id, peer_id)
        return
    cmid = obj.get("conversation_message_id")
    payload = obj.get("payload") or {}
    action = payload.get("a", "")
    arg = payload.get("v", "")
    toast = {"gen": "⏳ Секунду…", "summ": "⏳ Секунду…", "cal": "⏳ Секунду…",
             "read": "✅ Прочитано", "arch": "📥 В архиве", "del": "🗑 Удалено"}.get(action, "")
    _answer_event(event_id, peer_id, toast)

    try:
        _dispatch(action, arg, cmid)
    except Exception as exc:  # noqa: BLE001 — показываем ошибку, не роняем функцию
        _send(f"⚠️ Не получилось: {exc}")


def _dispatch(action: str, arg: str, cmid: int | None) -> None:
    if action in ("read", "arch", "del"):
        _safe_remove(cmid)
        if action == "read":
            _build_clients()[0].mark_read(arg)
        elif action == "arch":
            _build_clients()[0].archive(arg)
        return

    if action == "gen":
        gmail = _build_clients()[0]
        email = gmail.get_email(arg)
        mid = _send("✍️ Пишу ответ…")
        text = _analyzer_run(lambda a: a.generate_reply(email))
        draft_id = uuid.uuid4().hex
        _state_put(f"drafts/{draft_id}.json", {"email": _email_to_dict(email), "text": text})
        if mid:
            _edit(mid, f"✍️ Черновик ответа (тема: {email.subject}):\n\n{text}",
                  keyboard=_draft_kb(draft_id))
        return

    if action == "summ":
        gmail = _build_clients()[0]
        email = gmail.get_email(arg)
        mid = _send("🧾 Готовлю саммари…")
        text = _analyzer_run(lambda a: a.summarize(email))
        if mid:
            _edit(mid, "🧾 Кратко:\n\n" + text, keyboard=_delete_kb())
        return

    if action == "cal":
        gmail, calendar = _build_clients()
        email = gmail.get_email(arg)
        mid = _send("📅 Ищу дату в письме…")
        event = _analyzer_run(lambda a: a.extract_event(email))
        if not event.has_event or event.start is None:
            if mid:
                _edit(mid, "📅 Явной даты в письме не нашёл — событие не создал.")
            return
        end = event.end or (event.start + timedelta(hours=1))
        title = event.title or email.subject
        calendar.create_event(title, event.start, end, event.location,
                              f"Из письма: {email.subject}\n{email.sender}")
        if mid:
            _edit(mid, f"📅 Событие создано: «{title}» — {event.start.strftime('%d.%m.%Y %H:%M')}")
        return

    if action in ("send", "gdraft", "cancel", "redo"):
        draft = _state_get(f"drafts/{arg}.json")
        if action == "cancel":
            _state_del(f"drafts/{arg}.json")
            _send("✖ Отменено.")
            return
        if not draft:
            _send("Черновик устарел, сгенерируй заново.")
            return
        if action == "redo":
            _state_put(f"edit/{USER_ID}", {"draft_id": arg})
            _send("✏️ Пришли одним сообщением, что поправить в ответе.")
            return
        email = _email_from_dict(draft["email"])
        gmail = _build_clients()[0]
        if action == "send":
            gmail.send_reply(email, draft["text"])
            _send("✅ Ответ отправлен.")
        else:  # gdraft
            gmail.save_draft(email, draft["text"])
            _send("📝 Черновик сохранён в Gmail — правь и отправляй из почты.")
        _state_del(f"drafts/{arg}.json")


def _safe_remove(cmid: int | None) -> None:
    """Удаляет карточку по cmid; если VK не даёт (старше ~24ч) — пытается снять кнопки."""
    if cmid is None:
        return
    r = _vk("messages.delete", peer_id=USER_ID, cmids=cmid, delete_for_all=1)
    if r.get("error"):
        _vk("messages.edit", peer_id=USER_ID, conversation_message_id=cmid,
            keyboard=json.dumps({"inline": True, "buttons": []}, ensure_ascii=False))


# ===================== вход функции =====================

def handler(event, context):  # noqa: ANN001, ANN201 — контракт Yandex Cloud Functions
    # Таймер-триггер (ежедневная проверка): у события триггера есть ключ "messages" верхнего уровня.
    if isinstance(event, dict) and event.get("messages"):
        check_mail()
        return {"statusCode": 200, "body": "ok"}

    # HTTP-вызов (VK Callback API)
    body = event.get("body", "") or ""
    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")
    try:
        upd = json.loads(body)
    except (ValueError, TypeError):
        return {"statusCode": 200, "body": "ok"}

    # Подтверждение адреса сервера: VK ждёт ровно строку-код из настроек группы.
    if upd.get("type") == "confirmation":
        return {"statusCode": 200, "body": VK_CONFIRMATION,
                "headers": {"Content-Type": "text/plain"}}

    if VK_SECRET and upd.get("secret") != VK_SECRET:
        return {"statusCode": 403, "body": "forbidden"}

    # Дедуп: если тяжёлая обработка длится дольше терпения VK, он повторно доставит то же
    # событие. Помечаем event_id как обработанный ДО работы, чтобы повтор не выполнил
    # действие дважды (критично для «отправить»/«в календарь»).
    event_id = upd.get("event_id")
    if event_id:
        seen_key = f"seen/{event_id}"
        if _state_get(seen_key) is not None:
            return {"statusCode": 200, "body": "ok"}
        _state_put(seen_key, {"done": 1})

    etype = upd.get("type")
    print(f"[handler] type={etype} event_id={event_id}", flush=True)
    try:
        obj = upd.get("object") or {}
        if etype == "message_new":
            handle_message(obj.get("message") or {})
        elif etype == "message_event":
            handle_callback(obj)
    except Exception as exc:  # noqa: BLE001 — всегда отвечаем "ok", чтобы VK не ретраил
        print(f"[handler-error] {etype}: {exc!r}", flush=True)
    return {"statusCode": 200, "body": "ok"}
