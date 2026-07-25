"""Собирает каталог ``build/`` для деплоя в Yandex Cloud Functions.

Кладёт рядом ``index.py`` (входная точка), ``requirements.txt`` и только те модули
пакета ``mail_service``, которые реально импортит функция (без PTB/pydantic-слоёв).
Кроссплатформенно (Windows/macOS/Linux): пути через ``pathlib``, без хардкода.
"""

from __future__ import annotations

import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
PKG_SRC = HERE.parent / "mail_service"
BUILD = HERE / "build"
NEEDED = ["__init__.py", "models.py", "gmail.py", "calendar_client.py", "analysis.py", "llm.py"]


def main() -> None:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    (BUILD / "mail_service").mkdir(parents=True)
    shutil.copy2(HERE / "index.py", BUILD / "index.py")
    shutil.copy2(HERE / "requirements.txt", BUILD / "requirements.txt")
    for name in NEEDED:
        shutil.copy2(PKG_SRC / name, BUILD / "mail_service" / name)
    print(f"Собрано в {BUILD}")


if __name__ == "__main__":
    main()
