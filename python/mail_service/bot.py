"""Telegram-слой: хендлеры команд/кнопок и сборка приложения (long-polling).

Здесь только UI и маршрутизация; вся доменная работа делегируется ``MailService``.
"""

from __future__ import annotations

import logging
from datetime import time as dtime

from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from . import telegram_ui as ui
from .config import Settings
from .llm import OpenRouterClient
from .models import CalendarOutcome, Email, Verdict
from .service import MailService

log = logging.getLogger(__name__)

_TOASTS = {"gen": "⏳ Секунду…", "summ": "⏳ Секунду…", "cal": "⏳ Секунду…",
           "read": "✅ Прочитано", "arch": "📥 В архиве"}


class MailAlertBot:
    def __init__(self, settings: Settings, service: MailService, llm: OpenRouterClient) -> None:
        self._settings = settings
        self._service = service
        self._llm = llm
        self._chat_id = settings.telegram_chat_id

    # ---------- сборка и запуск ----------

    def run(self) -> None:
        app = (
            ApplicationBuilder()
            .token(self._settings.telegram_token)
            .post_shutdown(self._on_shutdown)
            .build()
        )
        app.add_handler(CommandHandler("start", self._cmd_start))
        app.add_handler(CommandHandler("check", self._handle_check))
        app.add_handler(CallbackQueryHandler(self._on_callback))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._on_text))
        app.job_queue.run_daily(
            self._daily_check, time=dtime(hour=self._settings.daily_hour, tzinfo=self._settings.tz))
        log.info("Бот запущен (long-polling). Ежедневная проверка в %02d:00 %s.",
                 self._settings.daily_hour, self._settings.tz)
        app.run_polling(allowed_updates=Update.ALL_TYPES)

    async def _on_shutdown(self, _app: Application) -> None:
        await self._llm.aclose()

    # ---------- команды и сообщения ----------

    async def _cmd_start(self, update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
        if not self._is_owner(update):
            return
        await update.message.reply_text(
            "Привет! Я присылаю важные письма из Gmail с кнопками действий. Работаю по расписанию "
            "(~9:00), а кнопкой ниже (или /check) можно проверить вручную.",
            reply_markup=ui.main_keyboard())

    async def _handle_check(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self._is_owner(update):
            return
        await update.message.reply_text("🔄 Принял, проверяю почту…")
        important, result = await self._service.scan()
        await self._send_cards(context, important)
        await context.bot.send_message(
            self._chat_id,
            "📭 Новых писем нет." if result.scanned == 0
            else f"✅ Готово: разобрано {result.scanned}, важных {result.notified}.")

    async def _daily_check(self, context: ContextTypes.DEFAULT_TYPE) -> None:
        important, result = await self._service.scan()
        await self._send_cards(context, important)
        log.info("Утренняя проверка: разобрано %s, важных %s.", result.scanned, result.notified)

    async def _on_text(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if not self._is_owner(update):
            return
        text = (update.message.text or "").strip()
        if text == ui.CHECK_BUTTON:
            await self._handle_check(update, context)
            return
        draft_id = context.user_data.pop("await_edit", None)
        if draft_id and self._service.get_draft(draft_id):
            msg = await update.message.reply_text("✍️ Переписываю…")
            draft = await self._service.regenerate_reply(draft_id, text)
            if draft is None:
                await msg.edit_text("Черновик устарел, сгенерируй заново.")
                return
            await msg.edit_text(f"✍️ Обновлённый черновик:\n\n{draft.text}",
                                reply_markup=ui.draft_keyboard(draft_id))

    # ---------- кнопки ----------

    async def _on_callback(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        query = update.callback_query
        if query.message.chat.id != self._chat_id:
            await query.answer()
            return
        action, _, arg = query.data.partition(":")
        await query.answer(_TOASTS.get(action, ""))
        try:
            await self._dispatch(action, arg, query, context)
        except Exception as exc:  # noqa: BLE001 — показываем ошибку пользователю, не роняем бот
            log.error("Ошибка кнопки %s: %s", action, exc)
            await context.bot.send_message(self._chat_id, f"⚠️ Не получилось: {exc}")

    async def _dispatch(self, action, arg, query, context) -> None:
        bot = context.bot
        if action == "read":
            await query.message.delete()
            await self._service.mark_read(arg)
        elif action == "arch":
            await query.message.delete()
            await self._service.archive(arg)
        elif action == "gen":
            msg = await bot.send_message(self._chat_id, "✍️ Пишу ответ…")
            draft_id, draft = await self._service.generate_reply(arg)
            await msg.edit_text(f"✍️ Черновик ответа (тема: {draft.email.subject}):\n\n{draft.text}",
                                reply_markup=ui.draft_keyboard(draft_id))
        elif action == "summ":
            msg = await bot.send_message(self._chat_id, "🧾 Готовлю саммари…")
            await msg.edit_text("🧾 Кратко:\n\n" + await self._service.summarize(arg))
        elif action == "cal":
            msg = await bot.send_message(self._chat_id, "📅 Ищу дату в письме…")
            await msg.edit_text(_calendar_text(await self._service.make_calendar_event(arg)))
        elif action == "send":
            ok = await self._service.send_reply(arg)
            await bot.send_message(self._chat_id, "✅ Ответ отправлен." if ok else _STALE)
        elif action == "gdraft":
            ok = await self._service.save_reply_draft(arg)
            await bot.send_message(
                self._chat_id,
                "📝 Черновик сохранён в Gmail — правь и отправляй из почты." if ok else _STALE)
        elif action == "redo":
            if self._service.get_draft(arg):
                context.user_data["await_edit"] = arg
                await bot.send_message(self._chat_id, "✏️ Пришли одним сообщением, что поправить в ответе.")
            else:
                await bot.send_message(self._chat_id, _STALE)
        elif action == "cancel":
            self._service.discard_draft(arg)
            await bot.send_message(self._chat_id, "✖ Отменено.")

    # ---------- вспомогательное ----------

    async def _send_cards(
        self, context: ContextTypes.DEFAULT_TYPE, important: list[tuple[Email, Verdict]]
    ) -> None:
        for email, verdict in important:
            await context.bot.send_message(
                self._chat_id, ui.format_card(email, verdict), parse_mode=ParseMode.HTML,
                disable_web_page_preview=True, reply_markup=ui.action_keyboard(email.thread_id))

    def _is_owner(self, update: Update) -> bool:
        return update.effective_chat is not None and update.effective_chat.id == self._chat_id


_STALE = "Черновик устарел, сгенерируй заново."


def _calendar_text(outcome: CalendarOutcome) -> str:
    if outcome.status == "created" and outcome.start is not None:
        return f"📅 Событие создано: «{outcome.title}» — {outcome.start.strftime('%d.%m.%Y %H:%M')}"
    if outcome.status == "no_date":
        return "📅 Явной даты в письме не нашёл — событие не создал."
    return "📅 Не смог разобрать дату из письма."
