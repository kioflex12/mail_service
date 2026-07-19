"""Представление: клавиатуры и форматирование сообщений Telegram (без бизнес-логики)."""

from __future__ import annotations

import re

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
)

from .models import Email, Verdict

CHECK_BUTTON = "🔄 Проверить почту сейчас"

_CATEGORY_EMOJI = {
    "work": "💼", "personal": "✉️", "finance": "💰",
    "security": "🔐", "deadline": "⏰", "urgent": "🚨", "other": "🔔",
}


def action_keyboard(thread_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✍️ Ответ", callback_data=f"gen:{thread_id}"),
         InlineKeyboardButton("🧾 Саммари", callback_data=f"summ:{thread_id}")],
        [InlineKeyboardButton("📅 В календарь", callback_data=f"cal:{thread_id}")],
        [InlineKeyboardButton("📥 Архив", callback_data=f"arch:{thread_id}"),
         InlineKeyboardButton("✅ Прочитано", callback_data=f"read:{thread_id}")],
    ])


def draft_keyboard(draft_id: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("✅ Отправить", callback_data=f"send:{draft_id}")],
        [InlineKeyboardButton("📝 В черновик Gmail", callback_data=f"gdraft:{draft_id}"),
         InlineKeyboardButton("✏️ Переписать", callback_data=f"redo:{draft_id}")],
        [InlineKeyboardButton("✖ Отмена", callback_data=f"cancel:{draft_id}")],
    ])


def main_keyboard() -> ReplyKeyboardMarkup:
    return ReplyKeyboardMarkup([[KeyboardButton(CHECK_BUTTON)]],
                               resize_keyboard=True, is_persistent=True)


def format_card(email: Email, verdict: Verdict) -> str:
    link = f"https://mail.google.com/mail/u/0/#all/{email.thread_id}"
    snippet = re.sub(r"\s+", " ", email.body)[:300]
    emoji = _CATEGORY_EMOJI.get(verdict.category, "🔔")
    return (
        f"{emoji} <b>Требует внимания</b> (<i>{escape_html(verdict.category)}</i>)\n\n"
        f"<b>Тема:</b> {escape_html(email.subject)}\n"
        f"<b>От:</b> {escape_html(email.sender)}\n"
        f"<b>Почему:</b> {escape_html(verdict.reason)}\n\n"
        f"{escape_html(snippet)}\n\n"
        f'🔗 <a href="{link}">Открыть в Gmail</a>'
    )


def escape_html(text: str) -> str:
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
