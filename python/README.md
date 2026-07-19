# mail_service — Python-версия (long-polling)

Gmail → Telegram: важные письма с кнопками действий. **Мгновенный отклик** (long-polling,
без webhook/302), работает на любом всегда-включённом хосте. Утренняя проверка в 9:00 +
ручной `/check`, классификация писем через OpenRouter, важные — в Telegram с кнопками
(✍️ ответ / 🧾 саммари / 📅 календарь / 📥 архив / ✅ прочитано).

## Архитектура (слои)
```
mail_service/
  config.py           Settings (pydantic-settings) — конфиг из .env/окружения
  models.py           доменные dataclass-модели (Email, Verdict, ReplyDraft, …)
  google_auth.py      загрузка/обновление OAuth-креденшелов
  gmail.py            GmailClient — поиск, чтение, метки, архив, ответ, черновик
  calendar_client.py  CalendarClient — создание события
  llm.py              OpenRouterClient — чат с фолбэком по бесплатным моделям
  analysis.py         MailAnalyzer — классификация / ответ / саммари / событие
  telegram_ui.py      клавиатуры и форматирование сообщений
  service.py          MailService — оркестратор доменных операций (без Telegram)
  bot.py              MailAlertBot — хендлеры Telegram и запуск
  __main__.py         composition root — сборка зависимостей и старт
```
Зависимости внедряются в `__main__` (никаких глобальных клиентов на импорте); слой Telegram
не знает про Gmail/LLM напрямую — только через `MailService`.

## Требования
- Python 3.11+
- Всегда включённый хост (VPS / домашний сервер / RPi).

## 1. Зависимости
```bash
cd python
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Google OAuth (Gmail + Calendar)
1. <https://console.cloud.google.com> → создай/выбери проект.
2. **Enable APIs** → включи **Gmail API** и **Google Calendar API**.
3. **OAuth consent screen** → тип **External** → в **Test users** добавь свой gmail-адрес.
4. **Credentials → Create → OAuth client ID → Desktop app** → скачай JSON как **`credentials.json`** рядом с пакетом (в каталог `python/`).

> Первый запуск откроет браузер для согласия и создаст `token.json`. На headless-сервере
> сгенерируй `token.json` один раз локально (на машине с браузером) и скопируй на сервер.

## 3. Настройки
```bash
cp .env.example .env    # заполни TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY
```

## 4. Запуск
```bash
python -m mail_service
```
Проверь: `/start`, затем `/check` — отклик мгновенный.

## 5. Автозапуск 24/7 (systemd)
```bash
sudo cp deploy/mail-service.service /etc/systemd/system/   # поправь пути/пользователя
sudo systemctl daemon-reload
sudo systemctl enable --now mail-service
journalctl -u mail-service -f
```

## Качество кода
`pyproject.toml` содержит настройки ruff и mypy:
```bash
pip install ruff mypy
ruff check .
mypy mail_service
```

## Не коммитится (секреты)
`.env`, `credentials.json`, `token.json` — в `.gitignore`. Держи только на хосте.
