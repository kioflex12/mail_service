"""Доменный анализ писем через LLM: классификация, ответ, саммари, извлечение события."""

from __future__ import annotations

import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo

from .llm import OpenRouterClient
from .models import Email, EventInfo, Verdict

_CLASSIFY_BODY = 1500  # тела письма в промпт классификатора

_CLASSIFY_SYSTEM = (
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
    '"category":"<work|personal|finance|security|deadline|urgent|other>","reason":"<фраза на русском>"}]}'
)

_REPLY_SYSTEM = (
    "Ты пишешь ответ на письмо от лица получателя. Пиши на языке письма, вежливо и по делу, "
    "без выдуманных фактов. Верни ТОЛЬКО текст ответа — без темы, без «From/To», без пояснений. "
    "Не придумывай имя/подпись, если их нет в контексте."
)

_SUMMARY_SYSTEM = "Сожми письмо в 2–4 коротких пункта на русском. Только пункты списком, без вступления."

_EVENT_SYSTEM = (
    "Извлеки из письма событие (встреча, дедлайн, запись, созвон). Ответь ТОЛЬКО JSON без markdown: "
    '{"has_event":<bool>,"title":"<кратко>","start":"YYYY-MM-DD HH:mm",'
    '"end":"YYYY-MM-DD HH:mm или пусто","location":"<или пусто>"}. Если явной даты/времени нет — '
    "has_event=false. Год по умолчанию текущий, время по умолчанию 10:00."
)


class MailAnalyzer:
    """Обёртка над LLM с готовыми доменными операциями."""

    def __init__(self, llm: OpenRouterClient, tz: ZoneInfo) -> None:
        self._llm = llm
        self._tz = tz

    async def classify(self, emails: list[Email]) -> list[Verdict]:
        listing = "\n\n---\n\n".join(
            f"[{i}]\nFrom: {e.sender}\nSubject: {e.subject}\nBody (truncated): {e.body[:_CLASSIFY_BODY]}"
            for i, e in enumerate(emails)
        )
        user = "Классифицируй письма (по индексу i, 0-based):\n\n" + listing
        parsed = _parse_json(await self._llm.complete(_CLASSIFY_SYSTEM, user)) or {}
        by_index = {r.get("i"): r for r in parsed.get("results", [])}
        verdicts: list[Verdict] = []
        for i in range(len(emails)):
            r = by_index.get(i)
            verdicts.append(
                Verdict(bool(r["is_important"]), r.get("category", "other"), r.get("reason", ""))
                if r else Verdict(False, "other", "нет ответа модели")
            )
        return verdicts

    async def generate_reply(
        self, email: Email, previous: str | None = None, instructions: str | None = None
    ) -> str:
        user = f"Письмо, на которое отвечаем:\nFrom: {email.sender}\nSubject: {email.subject}\n\n{email.body}"
        if previous:
            user += (f"\n\n---\nТвой предыдущий черновик:\n{previous}"
                     f"\n\n---\nПоправь с учётом пожеланий: {instructions or ''}")
        return await self._llm.complete(_REPLY_SYSTEM, user, temperature=0.4)

    async def summarize(self, email: Email) -> str:
        user = f"From: {email.sender}\nSubject: {email.subject}\n\n{email.body}"
        return await self._llm.complete(_SUMMARY_SYSTEM, user, temperature=0.2)

    async def extract_event(self, email: Email) -> EventInfo:
        today = datetime.now(self._tz).strftime("%Y-%m-%d")
        user = f"Сегодня: {today}\nFrom: {email.sender}\nSubject: {email.subject}\n\n{email.body}"
        data = _parse_json(await self._llm.complete(_EVENT_SYSTEM, user)) or {}
        return EventInfo(
            has_event=bool(data.get("has_event")),
            title=data.get("title", "") or "",
            start=self._parse_local(data.get("start")),
            end=self._parse_local(data.get("end")),
            location=data.get("location", "") or "",
        )

    def _parse_local(self, value: str | None) -> datetime | None:
        if not value:
            return None
        m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})", str(value))
        if not m:
            return None
        return datetime(*(int(x) for x in m.groups()), tzinfo=self._tz)


def _parse_json(text: str) -> dict | None:
    """Достаёт JSON-объект из ответа модели (терпит обёртки/markdown)."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
