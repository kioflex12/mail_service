"""Деплой функции mail-service в Yandex Cloud без ручного ввода переменных.

Идея: секреты уже лежат локально по разным файлам — скрипт собирает из них полный
набор env для функции, а от человека берёт только 4 VK-значения из `.vk-env`. Это
убирает боль «вписывать ~13 переменных заново на каждую версию» и обходит проблему
yc+PowerShell (progress в stderr роняет команду под ErrorActionPreference=Stop) —
здесь yc вызывается через subprocess напрямую, без оболочки.

Откуда что берётся:
  .vk-env            → VK_GROUP_TOKEN, VK_USER_ID, VK_CONFIRMATION, VK_SECRET (заполняешь ты)
  ../.env            → OPENROUTER_API_KEY, TIMEZONE, LOOKBACK_DAYS, MAX_THREADS, GMAIL_QUERY_EXTRA
  ../token.json      → GMAIL_REFRESH_TOKEN, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET
  .yc-sa-key.json    → AWS_ACCESS_KEY_ID (access_key.key_id), AWS_SECRET_ACCESS_KEY (secret)
  .deploy-state.json → STATE_BUCKET (bucket)

Использование:
  python deploy.py --dry-run   # собрать и показать команду (секреты замаскированы), не деплоить
  python deploy.py             # собрать build/ и создать новую версию функции

Кроссплатформенно: пути через pathlib, yc ищется в PATH / $YC_BIN / ~/yandex-cloud/bin.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import build as build_module  # соседний build.py — собирает build/

HERE = Path(__file__).resolve().parent
PY_DIR = HERE.parent

# Параметры функции (инфраструктура уже поднята — не пересоздаём).
FUNCTION_NAME = "mail-service"
SERVICE_ACCOUNT_ID = "ajemg8mk1miigv6ckau7"
RUNTIME = "python312"
ENTRYPOINT = "index.handler"
MEMORY = "512m"
TIMEOUT = "300s"

# Какие env-переменные — секретные (маскируем в выводе --dry-run).
_SECRET_KEYS = {
    "VK_GROUP_TOKEN", "VK_SECRET", "OPENROUTER_API_KEY", "GMAIL_REFRESH_TOKEN",
    "GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
}


def _read_json(path: Path) -> dict:
    # utf-8-sig: файлы, записанные под Windows, часто с BOM — json.load на нём падает.
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def _read_dotenv(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


def _require(path: Path, hint: str) -> Path:
    if not path.exists():
        sys.exit(f"Нет файла {path} — {hint}")
    return path


def collect_env() -> dict[str, str]:
    """Собирает полный набор переменных окружения функции из локальных файлов."""
    vk = _read_dotenv(_require(HERE / ".vk-env", "заполни его по .vk-env.example (4 VK-значения)"))
    dotenv = _read_dotenv(PY_DIR / ".env")
    token = _read_json(_require(PY_DIR / "token.json", "нет OAuth-токена Gmail (см. основной README)"))
    sa = _read_json(_require(HERE / ".yc-sa-key.json", "ключ сервисного аккаунта для Object Storage"))
    state = _read_json(HERE / ".deploy-state.json") if (HERE / ".deploy-state.json").exists() else {}

    missing = [k for k in ("VK_GROUP_TOKEN", "VK_USER_ID", "VK_CONFIRMATION", "VK_SECRET") if not vk.get(k)]
    if missing:
        sys.exit(f"В .vk-env не заполнены: {', '.join(missing)}")

    env = {
        "VK_GROUP_TOKEN": vk["VK_GROUP_TOKEN"],
        "VK_USER_ID": vk["VK_USER_ID"],
        "VK_CONFIRMATION": vk["VK_CONFIRMATION"],
        "VK_SECRET": vk["VK_SECRET"],
        "OPENROUTER_API_KEY": dotenv["OPENROUTER_API_KEY"],
        "GMAIL_REFRESH_TOKEN": token["refresh_token"],
        "GMAIL_CLIENT_ID": token["client_id"],
        "GMAIL_CLIENT_SECRET": token["client_secret"],
        "STATE_BUCKET": state.get("bucket", "mail-service-state-emyashev"),
        "AWS_ACCESS_KEY_ID": sa["access_key"]["key_id"],
        "AWS_SECRET_ACCESS_KEY": sa["secret"],
        # необязательные — с дефолтами index.py, переопределяем из .env если задано
        "TIMEZONE": dotenv.get("TIMEZONE", "Europe/Moscow"),
        "LOOKBACK_DAYS": dotenv.get("LOOKBACK_DAYS", "2"),
        "MAX_THREADS": dotenv.get("MAX_THREADS", "40"),
        "GMAIL_QUERY_EXTRA": dotenv.get("GMAIL_QUERY_EXTRA", "in:anywhere"),
    }
    # .vk-env имеет приоритет над .env для тюнинг-переменных: serverless можно настроить
    # (напр. MAX_THREADS поменьше — бесплатным моделям тяжело классифицировать много писем зараз),
    # не трогая локальный .env длинного поллинга.
    for key in ("TIMEZONE", "LOOKBACK_DAYS", "MAX_THREADS", "GMAIL_QUERY_EXTRA"):
        if vk.get(key):
            env[key] = vk[key]
    return env


def _find_yc() -> str:
    """yc из $YC_BIN, затем из PATH, затем стандартный путь установки в домашней папке."""
    import os
    if (env_bin := os.environ.get("YC_BIN")) and Path(env_bin).exists():
        return env_bin
    if found := shutil.which("yc"):
        return found
    home_bin = Path.home() / "yandex-cloud" / "bin" / ("yc.exe" if sys.platform == "win32" else "yc")
    if home_bin.exists():
        return str(home_bin)
    sys.exit("Не нашёл yc CLI: добавь в PATH или задай переменную окружения YC_BIN.")


def _build_command(yc: str, env: dict[str, str]) -> list[str]:
    cmd = [
        yc, "serverless", "function", "version", "create",
        "--function-name", FUNCTION_NAME,
        "--runtime", RUNTIME,
        "--entrypoint", ENTRYPOINT,
        "--memory", MEMORY,
        "--execution-timeout", TIMEOUT,
        "--source-path", str(HERE / "build"),
        "--service-account-id", SERVICE_ACCOUNT_ID,
    ]
    for key, val in env.items():
        cmd += ["--environment", f"{key}={val}"]
    return cmd


def _mask(cmd: list[str]) -> list[str]:
    out = []
    for part in cmd:
        if part.startswith(tuple(f"{k}=" for k in _SECRET_KEYS)):
            key = part.split("=", 1)[0]
            out.append(f"{key}=***")
        else:
            out.append(part)
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Деплой mail-service в Yandex Cloud")
    parser.add_argument("--dry-run", action="store_true",
                        help="показать команду (секреты замаскированы) и выйти, не деплоить")
    args = parser.parse_args()

    env = collect_env()
    yc = _find_yc()
    cmd = _build_command(yc, env)

    if args.dry_run:
        print("yc =", yc)
        print("env-переменных:", len(env))
        print(" ".join(_mask(cmd)))
        return

    print("Собираю build/ …")
    build_module.main()
    print("Создаю новую версию функции …")
    # команда собрана из констант проекта, не из пользовательского ввода
    result = subprocess.run(cmd, cwd=HERE)
    if result.returncode != 0:
        sys.exit(f"yc вернул код {result.returncode}")
    print("Готово. Проверь логи: yc logging read --resource-ids <function-id> --since 10m")


if __name__ == "__main__":
    main()
