# Деплой в Yandex Cloud (serverless, 24/7, бесплатно)

Бот живёт как **Cloud Function** — работает без включённого ПК и в рамках бесплатного
грейда (несколько вызовов в день + крохотное состояние в Object Storage ≈ 0 ₽).

Один вход `index.handler` обслуживает два сценария:
- **HTTP-вызов** (публичный URL функции = адрес сервера VK Callback API) — кнопки и `/check`;
- **Timer-триггер** (ежедневно 06:00 UTC = 09:00 МСК) — тихая проверка почты.

Мессенджер — **VK**, а не Telegram: из РФ-облака Yandex Telegram недостижим в обе стороны,
VK доступен. Доменная логика переиспользуется из пакета `mail_service` (`gmail`, `analysis`,
`llm`, `calendar_client`, `models`); здесь только транспорт (VK API напрямую, клавиатуры-словари)
и состояние (черновики/ожидание правки/дедуп) в Object Storage.

## Что уже развёрнуто (это окружение)

| Ресурс | Значение |
|--------|----------|
| Функция | `mail-service` (`d4eeuk5il83rf9g5og4u`) |
| URL / webhook | `https://functions.yandexcloud.net/d4eeuk5il83rf9g5og4u` |
| Сервисный аккаунт | `mail-service-sa` (`ajemg8mk1miigv6ckau7`) — роли `storage.editor`, `serverless.functions.invoker` |
| Бакет состояния | `mail-service-state-emyashev` |
| Таймер | `mail-daily`, cron `0 6 ? * * *` (09:00 МСК) |
| Рантайм | `python312`, память 512 МБ, таймаут 300 с |

Секреты лежат **только** в переменных окружения функции (VK group token, VK user id,
OpenRouter-ключ, Gmail refresh-token, ключ SA для Object Storage, `VK_SECRET`) —
в публичный репозиторий не попадают. Локальные файлы деплоя (`.yc-sa-key.json`,
`.deploy-state.json`, `build/`) в `.gitignore`.

## Настройка VK (один раз)

1. **Сообщество.** vk.com → Сообщества → «Создать сообщество» (тип любой). Оно будет ботом.
2. **Разрешить сообщения.** Управление → Настройки → Сообщения → включить «Сообщения сообщества».
3. **Ключ доступа (`VK_GROUP_TOKEN`).** Управление → Настройки → Работа с API → Ключи доступа →
   «Создать ключ», отметить право **«Сообщения сообщества»**. Скопировать.
4. **Свой id (`VK_USER_ID`).** Открыть в браузере (подставив свой короткий адрес страницы и токен):
   `https://api.vk.com/method/users.get?user_ids=ТВОЙ_АДРЕС&access_token=VK_GROUP_TOKEN&v=5.199` —
   в ответе поле `id`. Это получатель карточек (владелец).
5. **Строка подтверждения (`VK_CONFIRMATION`).** Управление → Работа с API → Callback API →
   поле «Строка, которую должен вернуть сервер». Скопировать (сервер обязан вернуть её при проверке).
6. **Заполнить `.vk-env`** (по `.vk-env.example`): `VK_GROUP_TOKEN`, `VK_USER_ID`, `VK_CONFIRMATION`,
   `VK_SECRET` (последний придумываешь сам, латиница/цифры).
7. **Задеплоить** (см. ниже) — чтобы функция уже умела отвечать на подтверждение.
8. **Указать сервер в VK.** Callback API → «Настройки сервера»: адрес = URL функции; секретный ключ =
   тот же `VK_SECRET`; тип API — **Callback** (не Long Poll), версия ≥ 5.199. Сохранить → статус «OK».
9. **Типы событий.** Callback API → «Типы событий»: включить **«Входящее сообщение»** (`message_new`)
   и **«Событие в кнопке» / callback-кнопки** (`message_event`).
10. **Открыть диалог.** Со своего аккаунта написать сообществу `/start` — чтобы бот мог тебе писать.

Порядок важен: подтверждение адреса (шаг 8) сработает только после деплоя (шаг 7) с уже заданным
`VK_CONFIRMATION` — иначе функции нечем ответить VK.

## Сборка пакета

```bash
python build.py   # собирает build/ : index.py + requirements.txt + нужные модули mail_service
```

## Переменные окружения функции

`VK_GROUP_TOKEN`, `VK_USER_ID`, `VK_CONFIRMATION`, `VK_SECRET`, `OPENROUTER_API_KEY`,
`GMAIL_REFRESH_TOKEN`, `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`,
`STATE_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`TIMEZONE` (по умолчанию `Europe/Moscow`), `LOOKBACK_DAYS`, `MAX_THREADS`, `GMAIL_QUERY_EXTRA`.

VK-переменные берутся из настроек сообщества: `VK_GROUP_TOKEN` — ключ доступа сообщества
(Управление → Работа с API, права `messages`); `VK_USER_ID` — числовой id получателя (владельца);
`VK_CONFIRMATION` — строка подтверждения адреса сервера (Callback API → Строка, которую вернёт сервер);
`VK_SECRET` — секретный ключ Callback API (сверяется в `handler` по полю `secret` в теле события).
`GMAIL_*` берутся из локального `token.json`; `AWS_*` — статический ключ сервисного аккаунта
для S3-совместимого Object Storage.

## Развернуть с нуля (кратко)

```bash
yc iam service-account create --name mail-service-sa
yc resource-manager folder add-access-binding <folder> --role storage.editor --subject serviceAccount:<sa>
yc resource-manager folder add-access-binding <folder> --role serverless.functions.invoker --subject serviceAccount:<sa>
yc iam access-key create --service-account-id <sa> --format json > .yc-sa-key.json
yc storage bucket create --name <bucket>
yc serverless function create --name mail-service

python build.py
yc serverless function version create --function-name mail-service --runtime python312 \
  --entrypoint index.handler --memory 512m --execution-timeout 300s --source-path build \
  --service-account-id <sa> --environment KEY=VALUE ...   # все переменные выше
yc serverless function allow-unauthenticated-invoke --name mail-service

# VK Callback API (в настройках сообщества → Работа с API → Callback API):
#   1) адрес сервера = URL функции;
#   2) при сохранении VK шлёт {"type":"confirmation"} — handler вернёт строку VK_CONFIRMATION;
#   3) секретный ключ = VK_SECRET (сверяется по полю "secret" в теле события);
#   4) тип API — Callback (не Long Poll), версия ≥ 5.199;
#   5) отметить события: «Входящее сообщение» (message_new) и «Событие в кнопке» (message_event).

yc serverless trigger create timer --name mail-daily --cron-expression "0 6 ? * * *" \
  --invoke-function-name mail-service --invoke-function-service-account-id <sa>
```

## Обновить код

Проще всего — скриптом `deploy.py`: он собирает `build/` и создаёт новую версию, вытягивая все
переменные из локальных файлов (`.vk-env`, `../.env`, `../token.json`, `.yc-sa-key.json`,
`.deploy-state.json`), так что вручную вписывать ~15 env заново не нужно.

```bash
python deploy.py --dry-run   # показать команду (секреты замаскированы), ничего не деплоить
python deploy.py             # собрать build/ и создать новую версию функции
```

Скрипт зовёт `yc` через subprocess (обходит проблему yc+PowerShell с progress в stderr); ищет `yc`
в `PATH`, затем в `$YC_BIN`, затем в `~/yandex-cloud/bin`. Вручную — как в разделе «Развернуть с нуля».

Адрес сервера в VK переустанавливать не нужно — URL функции не меняется между версиями.

## Важно

- **Callback API, а не Long Poll.** Функция serverless — она не может держать долгий опрос;
  VK сам стучится в URL функции. Тип API в настройках сообщества должен быть Callback.
- **Отвечать быстро.** VK ждёт `"ok"` и ретраит, если не дождался; поэтому дедуп по `event_id`
  (ключи `seen/` в Object Storage) обязателен — иначе повтор выполнит действие дважды.
- Логи: `yc logging read --resource-ids <function-id> --since 10m`.
