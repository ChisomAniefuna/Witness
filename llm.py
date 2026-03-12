from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

import httpx


OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
GEMINI_URL_TEMPLATE = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
)


class LLMError(RuntimeError):
    pass


def _split_data_url(data_url: str) -> Tuple[str, str]:
    if not data_url.startswith("data:") or "," not in data_url:
        raise LLMError("Expected data URL for image content.")
    header, data = data_url.split(",", 1)
    mime = header.split(";", 1)[0].split(":", 1)[1]
    return mime, data


def _openai_to_gemini(messages: List[Dict[str, Any]]) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    system_instruction: Optional[str] = None
    contents: List[Dict[str, Any]] = []

    for message in messages:
        role = message.get("role")
        content = message.get("content")

        if role == "system":
            if isinstance(content, list):
                system_text = "".join(part.get("text", "") for part in content if part.get("type") == "text")
            else:
                system_text = str(content or "")
            system_instruction = system_text if system_instruction is None else system_instruction + "\n" + system_text
            continue

        parts: List[Dict[str, Any]] = []
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "text":
                    parts.append({"text": part.get("text", "")})
                elif part.get("type") == "image_url":
                    image_url = part.get("image_url", {}).get("url", "")
                    mime, data = _split_data_url(image_url)
                    parts.append({"inline_data": {"mime_type": mime, "data": data}})
        else:
            parts.append({"text": str(content or "")})

        gemini_role = "user" if role == "user" else "model"
        contents.append({"role": gemini_role, "parts": parts})

    return system_instruction, contents


async def _call_openrouter(
    messages: List[Dict[str, Any]],
    model: str,
    json_mode: bool,
    temperature: float,
    max_tokens: Optional[int],
) -> str:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise LLMError("OPENROUTER_API_KEY is not set.")

    payload: Dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(OPENROUTER_URL, json=payload, headers=headers)

    if response.status_code >= 400:
        raise LLMError(f"OpenRouter error {response.status_code}: {response.text}")

    data = response.json()
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("Malformed OpenRouter response.") from exc


async def _call_gemini(
    messages: List[Dict[str, Any]],
    model: str,
    json_mode: bool,
    temperature: float,
    max_tokens: Optional[int],
) -> str:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise LLMError("GEMINI_API_KEY is not set.")

    system_instruction, contents = _openai_to_gemini(messages)

    generation_config: Dict[str, Any] = {"temperature": temperature}
    if max_tokens is not None:
        generation_config["maxOutputTokens"] = max_tokens
    if json_mode:
        generation_config["responseMimeType"] = "application/json"

    payload: Dict[str, Any] = {
        "contents": contents,
        "generationConfig": generation_config,
    }
    if system_instruction:
        payload["system_instruction"] = {"parts": [{"text": system_instruction}]}

    url = GEMINI_URL_TEMPLATE.format(model=model, key=api_key)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(url, json=payload)

    if response.status_code >= 400:
        raise LLMError(f"Gemini error {response.status_code}: {response.text}")

    data = response.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(part.get("text", "") for part in parts if "text" in part)
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("Malformed Gemini response.") from exc


async def call_llm(
    messages: List[Dict[str, Any]],
    model: str,
    json_mode: bool = False,
    temperature: float = 0.4,
    max_tokens: Optional[int] = None,
) -> str:
    backend = os.getenv("LLM_BACKEND", "gemini").lower().strip()

    if backend == "openrouter":
        return await _call_openrouter(messages, model, json_mode, temperature, max_tokens)
    if backend == "gemini":
        return await _call_gemini(messages, model, json_mode, temperature, max_tokens)

    raise LLMError(f"Unsupported LLM_BACKEND: {backend}")
