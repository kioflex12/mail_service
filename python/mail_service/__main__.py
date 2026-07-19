"""Точка входа: собирает зависимости (composition root) и запускает бота.

Запуск:  python -m mail_service   (из каталога python/, где лежат .env и credentials.json)
"""

from __future__ import annotations

import logging

from .analysis import MailAnalyzer
from .bot import MailAlertBot
from .calendar_client import CalendarClient
from .config import Settings
from .gmail import GmailClient
from .google_auth import load_credentials
from .llm import OpenRouterClient
from .service import MailService


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    settings = Settings()  # значения из .env / окружения

    credentials = load_credentials(settings.google_credentials, settings.google_token)
    gmail = GmailClient(credentials)
    calendar = CalendarClient(credentials, settings.tz)
    llm = OpenRouterClient(settings.openrouter_api_key)
    analyzer = MailAnalyzer(llm, settings.tz)
    service = MailService(
        gmail,
        calendar,
        analyzer,
        lookback_days=settings.lookback_days,
        gmail_query_extra=settings.gmail_query_extra,
        max_threads=settings.max_threads,
    )

    MailAlertBot(settings, service, llm).run()


if __name__ == "__main__":
    main()
