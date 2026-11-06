"""Every LLM call in Shadow Run goes through this file, and only to Vultr Serverless Inference."""
from __future__ import annotations

import contextvars
import json
import logging
import re
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

from control import settings

log = logging.getLogger("shadowrun.llm")

VULTR_HOST = "api.vultrinference.com"

# Each run gets its own list, so per-phase cost reports cannot mix runs.
usage_sink: contextvars.ContextVar[list[dict] | None] = contextvars.ContextVar("usage_sink", default=None)

_prices: dict[str, tuple[float, float]] = {}


class LLMError(RuntimeError):
    pass


def is_vultr_base(url: str) -> bool:
    return urlparse(url).hostname == VULTR_HOST


def load_prices() -> dict[str, tuple[float, float]]:
    """USD per token from the live model list, which needs no key."""
    if _prices:
        return _prices
    base = settings.INFERENCE_BASE.rstrip("/")
    data = httpx.get(f"{base}/models", timeout=20).json()["data"]
    for m in data:
        p = {
            x["type"]: float(x["cost_usd"])
            for io in m.get("input_modalities", []) + m.get("output_modalities", [])
            for x in io.get("pricing", [])
            if x.get("unit") == "token"
        }
        _prices[m["id"]] = (p.get("prompt", 0.0), p.get("completion", 0.0))
    return _prices


def cost_usd(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    try:
        p_in, p_out = load_prices().get(model, (0.0, 0.0))
    except (httpx.HTTPError, KeyError, ValueError):
        return 0.0
    return prompt_tokens * p_in + completion_tokens * p_out


def _client() -> OpenAI:
    if not is_vultr_base(settings.INFERENCE_BASE):
        raise LLMError(f"refusing to call a non-Vultr inference endpoint: {settings.INFERENCE_BASE}")
    return OpenAI(base_url=settings.INFERENCE_BASE, api_key=settings.require_secret("VULTR_INFERENCE_KEY", settings.INFERENCE_KEY), timeout=180, max_retries=0)


def _record(phase: str, model: str, usage: Any, seconds: float) -> dict:
    prompt = getattr(usage, "prompt_tokens", 0) or 0
    completion = getattr(usage, "completion_tokens", 0) or 0
    rec = {
        "phase": phase, "model": model, "prompt_tokens": prompt, "completion_tokens": completion,
        "cost_usd": cost_usd(model, prompt, completion), "seconds": round(seconds, 2),
    }
    sink = usage_sink.get()
    if sink is not None:
        sink.append(rec)
    return rec


def chat(phase: str, model: str, messages: list[dict], *, max_tokens: int = 6000, temperature: float = 0.1,
         response_format: dict | None = None, reasoning: str | None = "low") -> str:
    """One chat completion with retries on transient failure. Empty content retries with a bigger budget."""
    client = _client()
    last: Exception | None = None
    budget = max_tokens
    for attempt in range(4):
        t0 = time.perf_counter()
        try:
            kwargs: dict[str, Any] = {"model": model, "messages": messages, "max_tokens": budget, "temperature": temperature}
            if response_format:
                kwargs["response_format"] = response_format
            if reasoning:
                kwargs["extra_body"] = {"reasoning_effort": reasoning}
            r = client.chat.completions.create(**kwargs)
        except (APITimeoutError, APIConnectionError) as e:
            last = e
        except APIStatusError as e:
            last = e
            if e.status_code < 500 and e.status_code != 429:
                raise LLMError(f"{model}: HTTP {e.status_code}: {str(e)[:300]}") from e
        else:
            _record(phase, model, r.usage, time.perf_counter() - t0)
            text = (r.choices[0].message.content or "") if r.choices else ""
            if text.strip():
                return text
            last = LLMError(f"{model}: empty reply (finish_reason={r.choices[0].finish_reason if r.choices else None})")
            budget = min(budget * 2, 24000)
            continue
        time.sleep(1.5 * (attempt + 1))
    raise LLMError(f"{model}: {type(last).__name__}: {str(last)[:300]}")


def parse_json(text: str) -> Any:
    """Tolerates code fences and prose around the object, which several models add."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text, strict=False)
    except ValueError:
        pass
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON object in reply")
    return json.loads(m.group(0), strict=False)


def chat_json(phase: str, model: str, messages: list[dict], schema: dict, *, name: str = "reply", **kw) -> dict:
    """JSON output against a schema, with one repair retry. No tool calling is needed for this."""
    fmt = {"type": "json_schema", "json_schema": {"name": name, "schema": schema}}
    text = chat(phase, model, messages, response_format=fmt, **kw)
    try:
        return _check_required(parse_json(text), schema)
    except ValueError as e:
        repair = messages + [
            {"role": "assistant", "content": text[:4000]},
            {"role": "user", "content": f"That was not valid JSON for the required schema ({e}). Reply with only the JSON object."},
        ]
        return _check_required(parse_json(chat(f"{phase}_repair", model, repair, response_format=fmt, **kw)), schema)


def _check_required(obj: Any, schema: dict) -> dict:
    if not isinstance(obj, dict):
        raise ValueError("reply is not an object")
    missing = [k for k in schema.get("required", []) if k not in obj]
    if missing:
        raise ValueError(f"missing keys: {missing}")
    return obj


def safety_verdict(text: str) -> dict:
    """Second opinion from Vultr's content-safety model. Advisory only: never allows anything."""
    reply = chat("content_safety", settings.SAFETY_MODEL, [{"role": "user", "content": text[:4000]}], max_tokens=80, temperature=0, reasoning=None)
    m = re.search(r"User Safety:\s*(\w+)", reply, re.I)
    verdict = m.group(1).lower() if m else ("unsafe" if re.search(r"\bunsafe\b", reply, re.I) else "unknown")
    return {"model": settings.SAFETY_MODEL, "verdict": verdict, "raw": reply[:160]}
