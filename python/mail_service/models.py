"""Доменные модели — простые неизменяемые (там, где уместно) структуры данных."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

Category = Literal["work", "personal", "finance", "security", "deadline", "urgent", "other"]


@dataclass(slots=True)
class Email:
    """Письмо (последнее сообщение треда), с которым работает бот."""

    thread_id: str
    sender: str
    subject: str
    body: str
    message_id: str = ""
    references: str = ""


@dataclass(slots=True)
class Verdict:
    """Результат классификации письма моделью."""

    is_important: bool
    category: str = "other"
    reason: str = ""


@dataclass(slots=True)
class ReplyDraft:
    """Сгенерированный черновик ответа, ожидающий действия пользователя."""

    email: Email
    text: str


@dataclass(slots=True)
class EventInfo:
    """Событие, извлечённое из письма (для календаря)."""

    has_event: bool
    title: str
    start: datetime | None
    end: datetime | None
    location: str


@dataclass(slots=True)
class CheckResult:
    """Итог одного прогона проверки почты."""

    scanned: int
    notified: int


@dataclass(slots=True)
class CalendarOutcome:
    """Результат попытки создать событие из письма."""

    status: Literal["created", "no_date", "unparsable"]
    title: str = ""
    start: datetime | None = None
    raw: str = ""
