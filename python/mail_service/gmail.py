"""Клиент Gmail: поиск, чтение, метки, архив, «прочитано», ответ, черновик.

Методы синхронные (Google API-клиент блокирующий); вызывающий асинхронный код
оборачивает их в ``asyncio.to_thread``.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage as MimeMessage
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from .models import Email

_MAX_BODY = 6000  # чем ограничиваем тело письма при чтении


class GmailClient:
    def __init__(self, credentials: Credentials, *, processed_label: str = "MailServiceProcessed") -> None:
        self._svc = build("gmail", "v1", credentials=credentials, cache_discovery=False)
        self._processed_label = processed_label
        self._label_id: str | None = None

    # ---------- публичное API ----------

    def search_unprocessed(self, *, lookback_days: int, extra_query: str, max_threads: int) -> list[Email]:
        """Треды за N дней без метки «разобрано» — последнее сообщение каждого."""
        query = f"newer_than:{lookback_days}d -label:{self._processed_label}"
        if extra_query:
            query += f" {extra_query}"
        resp = self._svc.users().threads().list(
            userId="me", q=query, maxResults=max_threads).execute()
        emails: list[Email] = []
        for ref in resp.get("threads", []):
            thread = self._get_thread(ref["id"])
            messages = thread.get("messages", [])
            if messages:
                emails.append(self._to_email(ref["id"], messages[-1]))
        return emails

    def get_email(self, thread_id: str) -> Email:
        thread = self._get_thread(thread_id)
        return self._to_email(thread_id, thread["messages"][-1])

    def mark_processed(self, thread_id: str) -> None:
        self._svc.users().threads().modify(
            userId="me", id=thread_id, body={"addLabelIds": [self._processed_label_id()]}).execute()

    def archive(self, thread_id: str) -> None:
        self._modify_all(thread_id, {"removeLabelIds": ["INBOX"]})

    def mark_read(self, thread_id: str) -> None:
        self._modify_all(thread_id, {"removeLabelIds": ["UNREAD"]})

    def send_reply(self, email: Email, text: str) -> None:
        body = self._reply_mime(email, text)
        body["threadId"] = email.thread_id
        self._svc.users().messages().send(userId="me", body=body).execute()

    def save_draft(self, email: Email, text: str) -> None:
        body = self._reply_mime(email, text)
        body["threadId"] = email.thread_id
        self._svc.users().drafts().create(userId="me", body={"message": body}).execute()

    # ---------- внутреннее ----------

    def _get_thread(self, thread_id: str) -> dict[str, Any]:
        return self._svc.users().threads().get(userId="me", id=thread_id, format="full").execute()

    def _modify_all(self, thread_id: str, body: dict[str, Any]) -> None:
        for msg in self._get_thread(thread_id).get("messages", []):
            self._svc.users().messages().modify(userId="me", id=msg["id"], body=body).execute()

    def _processed_label_id(self) -> str:
        if self._label_id:
            return self._label_id
        labels = self._svc.users().labels().list(userId="me").execute().get("labels", [])
        for lb in labels:
            if lb["name"] == self._processed_label:
                self._label_id = lb["id"]
                return self._label_id
        created = self._svc.users().labels().create(
            userId="me", body={"name": self._processed_label}).execute()
        self._label_id = created["id"]
        return self._label_id

    @classmethod
    def _to_email(cls, thread_id: str, message: dict[str, Any]) -> Email:
        return Email(
            thread_id=thread_id,
            sender=cls._header(message, "From"),
            subject=cls._header(message, "Subject") or "(без темы)",
            body=cls._plain_body(message)[:_MAX_BODY],
            message_id=cls._header(message, "Message-ID"),
            references=cls._header(message, "References"),
        )

    @staticmethod
    def _header(message: dict[str, Any], name: str) -> str:
        for h in message.get("payload", {}).get("headers", []):
            if h["name"].lower() == name.lower():
                return h["value"]
        return ""

    @staticmethod
    def _plain_body(message: dict[str, Any]) -> str:
        def walk(part: dict[str, Any]) -> str:
            if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                return base64.urlsafe_b64decode(part["body"]["data"]).decode("utf-8", "replace")
            for sub in part.get("parts", []) or []:
                if found := walk(sub):
                    return found
            return ""

        return walk(message.get("payload", {})) or message.get("snippet", "")

    @staticmethod
    def _reply_mime(email: Email, text: str) -> dict[str, str]:
        mime = MimeMessage()
        mime["To"] = email.sender
        subject = email.subject
        mime["Subject"] = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        if email.message_id:
            mime["In-Reply-To"] = email.message_id
            mime["References"] = f"{email.references} {email.message_id}".strip()
        mime.set_content(text)
        raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
        return {"raw": raw}
