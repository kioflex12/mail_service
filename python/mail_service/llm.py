"""Клиент OpenRouter: чат-запрос с фолбэком по нескольким бесплатным моделям.

Список бесплатных моделей подтягивается из API OpenRouter (кэш на 6 часов), чтобы
не устаревал при смене `:free`-слагов; при 429/недоступности перебираются следующие.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

log = logging.getLogger(__name__)

_API_URL = "https://openrouter.ai/api/v1/chat/completions"
_MODELS_URL = "https://openrouter.ai/api/v1/models"
_CACHE_TTL = 21_600  # 6 часов

# Аварийный список — если не удалось получить актуальный из API.
FALLBACK_MODELS: list[str] = [
    "qwen/qwen3-next-80b-a3b-instruct:free",
    "openai/gpt-oss-20b:free",
    "google/gemma-4-31b-it:free",
    "meta-llama/llama-3.3-70b-instruct:free",
]

_PREFER = ("qwen3-next", "gpt-oss", "gemma-4", "gemma", "llama-3.3",
           "nemotron-3-super", "hermes", "mistral", "deepseek", "qwen")
_AVOID = re.compile(r"coder|vision|-vl|safety|guard|embed|reasoning|tts|whisper|image", re.I)


class LLMUnavailableError(RuntimeError):
    """Ни одна из бесплатных моделей не ответила."""


class OpenRouterClient:
    def __init__(self, api_key: str, *, request_timeout: float = 60.0) -> None:
        self._api_key = api_key
        self._http = httpx.AsyncClient(timeout=request_timeout)
        self._models: list[str] | None = None
        self._models_ts = 0.0

    async def aclose(self) -> None:
        await self._http.aclose()

    async def complete(self, system: str, user: str, *, temperature: float = 0.0) -> str:
        """Возвращает ответ модели. Перебирает модели с одним коротким ретраем на 429/5xx."""
        last_error = ""
        for model in await self._free_models():
            for attempt in range(2):
                resp = await self._http.post(
                    _API_URL,
                    headers={"Authorization": f"Bearer {self._api_key}", "X-Title": "mail-service"},
                    json={
                        "model": model,
                        "temperature": temperature,
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": user},
                        ],
                    },
                )
                if resp.status_code == 200:
                    content = (resp.json().get("choices", [{}])[0]
                               .get("message", {}).get("content", "") or "").strip()
                    if content:
                        return content
                    last_error = f"{model}: пустой ответ"
                    break
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_error = f"{model}: HTTP {resp.status_code}"
                    wait = _retry_after(resp)
                    if attempt == 0 and 0 < wait <= 8:
                        await asyncio.sleep(wait)
                        continue
                    break
                last_error = f"{model}: HTTP {resp.status_code} {resp.text[:120]}"
                break
        raise LLMUnavailableError(last_error or "нет доступных моделей")

    async def _free_models(self) -> list[str]:
        if self._models and time.time() - self._models_ts < _CACHE_TTL:
            return self._models
        try:
            resp = await self._http.get(_MODELS_URL, timeout=20)
            ids = [
                m["id"] for m in resp.json().get("data", [])
                if str(m["id"]).endswith(":free")
                and float(m.get("pricing", {}).get("prompt", 0) or 0) == 0
                and float(m.get("pricing", {}).get("completion", 0) or 0) == 0
            ]
            if ordered := _order_models(ids):
                self._models, self._models_ts = ordered, time.time()
                return ordered
        except Exception as exc:  # noqa: BLE001 — сеть/парсинг: спокойно откатываемся на фолбэк
            log.warning("Не удалось получить список моделей OpenRouter: %s", exc)
        return FALLBACK_MODELS


def _order_models(ids: list[str]) -> list[str]:
    """Пригодные для чата — вперёд, спорные (coder/vision/…) — в конец; максимум 8."""
    good = [i for i in ids if not _AVOID.search(i)]
    rest = [i for i in ids if _AVOID.search(i)]
    good.sort(key=lambda i: next((n for n, p in enumerate(_PREFER) if p in i), len(_PREFER)))
    return (good + rest)[:8]


def _retry_after(resp: httpx.Response) -> float:
    try:
        return float(resp.json()["error"]["metadata"]["retry_after_seconds"])
    except Exception:  # noqa: BLE001
        return 1.5
