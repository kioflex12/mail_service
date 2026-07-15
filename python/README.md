# mail_service — Python-версия (long-polling)

Тот же бот, что и на Apps Script, но на Python: **мгновенный отклик** (long-polling, без
webhook и без 302), работает на любом всегда-включённом хосте. Логика идентична:
утренняя проверка в 9:00 + ручной `/check`, классификация писем через OpenRouter,
важные — в Telegram с кнопками (✍️ ответ / 🧾 саммари / 📅 календарь / 📥 архив / ✅ прочитано).

## Требования
- Python 3.11+
- Всегда включённый хост (VPS / домашний сервер / RPi). На выключенном ПК бот, естественно, не работает.

## 1. Зависимости
```bash
cd python
python -m venv .venv
. .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 2. Google OAuth (доступ к Gmail и Calendar)
1. <https://console.cloud.google.com> → создай проект (или выбери существующий).
2. **APIs & Services → Enable APIs** → включи **Gmail API** и **Google Calendar API**.
3. **OAuth consent screen** → тип **External** → заполни минимум → в **Test users** добавь свой gmail-адрес (тот, чью почту мониторим).
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app** → скачай JSON, положи рядом с `bot.py` как **`credentials.json`**.

> Первый запуск откроет браузер для согласия и создаст `token.json` (дальше токен обновляется сам).
> **На headless-сервере** (без браузера): сгенерируй `token.json` один раз на своём компьютере
> (`python bot.py` локально — согласие в браузере), затем скопируй `token.json` на сервер.

## 3. Настройки
```bash
cp .env.example .env
# заполни TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, OPENROUTER_API_KEY (те же, что были)
```

## 4. Запуск
```bash
python bot.py
```
Проверь: напиши боту `/start`, затем `/check` — отклик должен быть **мгновенным**.

## 5. Автозапуск 24/7 (Linux, systemd)
Скопируй `deploy/mail-service.service`, поправь пути/пользователя, затем:
```bash
sudo cp deploy/mail-service.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mail-service
journalctl -u mail-service -f      # логи
```

## Файлы, которые НЕ коммитятся (секреты)
`.env`, `credentials.json`, `token.json` — они в `.gitignore`. Держи их только на хосте.

## Отличия от Apps Script-версии
- Отклик кнопок — мгновенный (long-polling), а не до ~1 минуты.
- Нужен всегда включённый хост (в этом вся разница).
- Дедуп разобранных писем — по той же Gmail-метке `MailServiceProcessed`.
- Список бесплатных моделей OpenRouter подтягивается из их API (кэш 6 ч), как и в GS-версии.
