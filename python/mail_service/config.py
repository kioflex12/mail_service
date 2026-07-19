"""Типизированная конфигурация приложения (читается из окружения / .env)."""

from __future__ import annotations

from functools import cached_property
from zoneinfo import ZoneInfo

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Все настройки бота. Значения берутся из переменных окружения или `.env`."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Секреты
    telegram_token: str
    telegram_chat_id: int
    openrouter_api_key: str

    # Расписание
    daily_hour: int = 9
    timezone: str = "Europe/Moscow"

    # Поиск писем
    lookback_days: int = 2
    max_threads: int = 40
    gmail_query_extra: str = "in:anywhere"

    # Google OAuth (пути к файлам относительно рабочего каталога)
    google_credentials: str = "credentials.json"
    google_token: str = "token.json"

    @cached_property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)
