"""Загрузка Google OAuth-креденшелов (Gmail + Calendar) с авто-обновлением токена."""

from __future__ import annotations

import os

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES: list[str] = [
    "https://www.googleapis.com/auth/gmail.modify",   # чтение, метки, архив, «прочитано»
    "https://www.googleapis.com/auth/gmail.compose",  # черновики
    "https://www.googleapis.com/auth/gmail.send",     # отправка ответа
    "https://www.googleapis.com/auth/calendar.events",
]


def load_credentials(credentials_file: str, token_file: str) -> Credentials:
    """Возвращает валидные креденшелы: из token-файла, обновляя или запрашивая согласие.

    При первом запуске (нет token-файла) открывает браузер для OAuth-согласия и
    сохраняет полученный токен в `token_file`.
    """
    creds: Credentials | None = None
    if os.path.exists(token_file):
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        flow = InstalledAppFlow.from_client_secrets_file(credentials_file, SCOPES)
        creds = flow.run_local_server(port=0)

    with open(token_file, "w", encoding="utf-8") as fh:
        fh.write(creds.to_json())
    return creds
