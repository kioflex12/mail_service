"""Оркестратор: связывает Gmail, Calendar и анализ в доменные операции бота.

Асинхронный слой: блокирующие вызовы Google API оборачиваются в ``asyncio.to_thread``,
LLM-операции — уже асинхронные. Никакой зависимости от Telegram здесь нет.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import timedelta

from .analysis import MailAnalyzer
from .calendar_client import CalendarClient
from .gmail import GmailClient
from .models import CalendarOutcome, CheckResult, Email, ReplyDraft, Verdict

log = logging.getLogger(__name__)


class MailService:
    def __init__(
        self,
        gmail: GmailClient,
        calendar: CalendarClient,
        analyzer: MailAnalyzer,
        *,
        lookback_days: int,
        gmail_query_extra: str,
        max_threads: int,
        batch_size: int = 20,
    ) -> None:
        self._gmail = gmail
        self._calendar = calendar
        self._analyzer = analyzer
        self._lookback_days = lookback_days
        self._gmail_query_extra = gmail_query_extra
        self._max_threads = max_threads
        self._batch_size = batch_size
        self._drafts: dict[str, ReplyDraft] = {}

    # ---------- проверка почты ----------

    async def scan(self) -> tuple[list[tuple[Email, Verdict]], CheckResult]:
        """Классифицирует новые письма, помечает разобранными, возвращает важные."""
        emails = await asyncio.to_thread(
            self._gmail.search_unprocessed,
            lookback_days=self._lookback_days,
            extra_query=self._gmail_query_extra,
            max_threads=self._max_threads,
        )
        important: list[tuple[Email, Verdict]] = []
        for start in range(0, len(emails), self._batch_size):
            batch = emails[start:start + self._batch_size]
            try:
                verdicts = await self._analyzer.classify(batch)
            except Exception as exc:  # noqa: BLE001 — пачку разберём в следующий раз
                log.error("Ошибка классификации пачки: %s", exc)
                continue
            for email, verdict in zip(batch, verdicts):
                if verdict.is_important:
                    important.append((email, verdict))
                await asyncio.to_thread(self._gmail.mark_processed, email.thread_id)
        return important, CheckResult(scanned=len(emails), notified=len(important))

    # ---------- ответ ----------

    async def generate_reply(self, thread_id: str) -> tuple[str, ReplyDraft]:
        email = await asyncio.to_thread(self._gmail.get_email, thread_id)
        text = await self._analyzer.generate_reply(email)
        draft_id = uuid.uuid4().hex
        draft = ReplyDraft(email=email, text=text)
        self._drafts[draft_id] = draft
        return draft_id, draft

    async def regenerate_reply(self, draft_id: str, instructions: str) -> ReplyDraft | None:
        draft = self._drafts.get(draft_id)
        if draft is None:
            return None
        draft.text = await self._analyzer.generate_reply(draft.email, draft.text, instructions)
        return draft

    def get_draft(self, draft_id: str) -> ReplyDraft | None:
        return self._drafts.get(draft_id)

    async def send_reply(self, draft_id: str) -> bool:
        draft = self._drafts.pop(draft_id, None)
        if draft is None:
            return False
        await asyncio.to_thread(self._gmail.send_reply, draft.email, draft.text)
        return True

    async def save_reply_draft(self, draft_id: str) -> bool:
        draft = self._drafts.pop(draft_id, None)
        if draft is None:
            return False
        await asyncio.to_thread(self._gmail.save_draft, draft.email, draft.text)
        return True

    def discard_draft(self, draft_id: str) -> None:
        self._drafts.pop(draft_id, None)

    # ---------- прочие действия ----------

    async def summarize(self, thread_id: str) -> str:
        email = await asyncio.to_thread(self._gmail.get_email, thread_id)
        return await self._analyzer.summarize(email)

    async def make_calendar_event(self, thread_id: str) -> CalendarOutcome:
        email = await asyncio.to_thread(self._gmail.get_email, thread_id)
        event = await self._analyzer.extract_event(email)
        if not event.has_event or event.start is None:
            return CalendarOutcome(status="no_date", raw=email.subject)
        end = event.end or (event.start + timedelta(hours=1))
        title = event.title or email.subject
        await asyncio.to_thread(
            self._calendar.create_event, title, event.start, end, event.location,
            f"Из письма: {email.subject}\n{email.sender}",
        )
        return CalendarOutcome(status="created", title=title, start=event.start)

    async def archive(self, thread_id: str) -> None:
        await asyncio.to_thread(self._gmail.archive, thread_id)

    async def mark_read(self, thread_id: str) -> None:
        await asyncio.to_thread(self._gmail.mark_read, thread_id)
