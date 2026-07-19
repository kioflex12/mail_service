"""Клиент Google Calendar: создание события. Метод синхронный (см. GmailClient)."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


class CalendarClient:
    def __init__(self, credentials: Credentials, tz: ZoneInfo) -> None:
        self._svc = build("calendar", "v3", credentials=credentials, cache_discovery=False)
        self._tz = tz

    def create_event(
        self, title: str, start: datetime, end: datetime, location: str, description: str
    ) -> None:
        self._svc.events().insert(
            calendarId="primary",
            body={
                "summary": title,
                "location": location,
                "description": description,
                "start": {"dateTime": start.isoformat(), "timeZone": str(self._tz)},
                "end": {"dateTime": end.isoformat(), "timeZone": str(self._tz)},
            },
        ).execute()
