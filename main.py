from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from llm import LLMError, call_llm
from state import (
    Accusation,
    CaseFile,
    ChatMessage,
    SceneObject,
    ScanResponse,
    Verdict,
    WitnessPersona,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("witness")


PROMPT_1 = """You are a forensic scene analyst for a noir murder mystery game.
The player has pointed their camera at a real room.
Analyse the image and return a JSON object with this exact shape:
{
"objects": [
{
"label": string, // name of the object
"x": number, // left position as % of image width (0-100)
"y": number, // top position as % of image height (0-100)
"w": number, // width as % of image width (0-100)
"h": number, // height as % of image height (0-100)
"flagged": boolean, // true if object looks suspicious or out of place
"description": string // one atmospheric sentence about this object
}
],
"witnessReaction": string // short nervous first-person line from a witness
// who was present in this room
}
Return between 3 and 7 objects. Focus on objects that could be
evidence in a murder case. Return only valid JSON. No markdown.
No explanation. No preamble.
EXAMPLE RESPONSE
{
"objects": [
{ "label": "Wine Glass", "x": 34, "y": 28, "w": 12, "h": 18,
"flagged": true, "description": "Half-full, lipstick on the rim." },
{ "label": "Open Window", "x": 68, "y": 15, "w": 22, "h": 35,
"flagged": false, "description": "Left slightly ajar despite the cold." },
{ "label": "Overturned Chair", "x": 12, "y": 55, "w": 18, "h": 24,
"flagged": true, "description": "Knocked back as if someone left in a hurry." }
],
"witnessReaction": "I was here that night. I remember every detail of this room."
}
"""

PROMPT_2 = """You are a creative director generating a murder mystery witness
for a noir game.
The player has scanned a room containing these objects:
[INJECT: objects array as comma-separated labels]
Generate a witness persona as a JSON object with this exact shape:
{
"name": string, // full name
"archetype": string, // e.g. "The Nervous Accountant"
"age": number,
"occupation": string,
"tells": string[], // 2-3 physical habits when lying
// e.g. "touches left earlobe", "looks up-right"
"openingStatement": string, // what they say when first approached -
// nervous, vague, hiding something
"guiltyOf": string, // their true crime or motive in one sentence
"secret": string, // the one thing they are desperately hiding
"speakingStyle": string // e.g. "clipped and formal", "rambling and defensive"
}
The witness IS guilty. Make them believable - not cartoonishly evil.
Their guilt should connect directly to at least two objects in the room.
Return only valid JSON. No markdown. No explanation.
"""

PROMPT_3_TEMPLATE = """You are {name}, a {archetype}, age {age},
occupation: {occupation}.
You are being interrogated by a detective about a crime that occurred
in a room containing: {object_labels}.
Your secret: {secret}
What you are guilty of: {guilty_of}
Your physical tells when lying: {tells}
Your speaking style: {speaking_style}
Rules you must follow:
- Stay fully in character at all times. Never break character.
- You are guilty but you must never directly admit it.
- Be nervous, evasive, and occasionally slip up.
- Keep every response under 80 words.
- If you contradict something you said earlier, insert the tag
[CONTRADICTION] at the start of that sentence only.
- Never mention being an AI, a game, or a language model.
- Refer to the detective as "Detective" - never by name.
CONVERSATION HISTORY FORMAT
Send the full history on every call. Never truncate.
"""

PROMPT_8_TEMPLATE = """You are the verdict engine for a noir murder mystery game.
The player has submitted their accusation:
Suspect: {suspect}
Method: {method}
Motive: {motive}
The true answer:
The witness is guilty.
Their motive: {guilty_of}
Their secret: {secret}
Key evidence objects: {evidence}
Evaluate the accusation and return JSON:
{
"correct": boolean,
"verdict": string, // dramatic one-liner - e.g.
// "Case closed. Justice served." or
// "Wrong. The killer walks free."
"explanation": string, // 2 sentences: what actually happened
"score": number // 0-100 based on how close the player got
}
Return only valid JSON. No markdown.
"""

PROMPT_9_TEMPLATE = """You are a case file analyst for a noir murder mystery game.
Here is the full interrogation transcript:
{conversation_history}
Witness persona:
Guilty of: {guilty_of}
Secret: {secret}
Annotate every witness message. For each witness turn, return:
{
"turn": number, // index in the conversation (0-based)
"text": string, // the original witness message
"verdict": "lie" | "truth" | "partial",
"note": string // one sentence explaining why - what they
// are hiding or revealing in this statement
}
Also, generate a 4-step timeline of what actually happened:
{
"timeline": [
{ "step": number, "time": string, "event": string }
]
}
Return a single JSON object:
{ "annotations": [...], "timeline": [...] }
No markdown. No explanation.
"""


MODEL_DEFAULTS_OPENROUTER = {
    "scan": "google/gemini-2.0-flash-exp:free",
    "persona": "google/gemini-pro:free",
    "chat": "google/gemini-2.0-flash-exp:free",
    "verdict": "google/gemini-2.0-flash-exp:free",
    "casefile": "google/gemini-pro:free",
}

MODEL_DEFAULTS_GEMINI = {
    "scan": "gemini-1.5-flash",
    "persona": "gemini-1.5-pro",
    "chat": "gemini-1.5-flash",
    "verdict": "gemini-1.5-flash",
    "casefile": "gemini-1.5-pro",
}

MODEL_ENV_MAP = {
    "scan": "MODEL_SCAN",
    "persona": "MODEL_PERSONA",
    "chat": "MODEL_CHAT",
    "verdict": "MODEL_VERDICT",
    "casefile": "MODEL_CASEFILE",
}


def _model_for(task: str) -> str:
    backend = os.getenv("LLM_BACKEND", "gemini").lower().strip()
    defaults = MODEL_DEFAULTS_OPENROUTER if backend == "openrouter" else MODEL_DEFAULTS_GEMINI
    env_key = MODEL_ENV_MAP.get(task)
    if env_key and os.getenv(env_key):
        return os.getenv(env_key, "")
    return defaults[task]


def _normalize_base64(data: str) -> str:
    if not data:
        return data
    if "base64," in data:
        data = data.split("base64,", 1)[1]
    return data.strip()


def _extract_json(text: str) -> Any:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*", "", cleaned).strip()
        cleaned = cleaned.strip("`")
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def _history_to_messages(history: List[ChatMessage]) -> List[Dict[str, Any]]:
    messages: List[Dict[str, Any]] = []
    for msg in history:
        role = "assistant" if msg.role in ("assistant", "model") else "user"
        messages.append({"role": role, "content": msg.content})
    return messages


def _normalize_history(history: List[ChatMessage]) -> List[ChatMessage]:
    normalized: List[ChatMessage] = []
    for msg in history:
        role = "model" if msg.role in ("assistant", "model") else "user"
        normalized.append(ChatMessage(role=role, content=msg.content))
    return normalized


class ScanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    image_base64: str = Field(validation_alias=AliasChoices("imageBase64", "base64", "image"))


class PersonaRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    scene_objects: List[SceneObject] = Field(
        default_factory=list, validation_alias=AliasChoices("sceneObjects", "objects")
    )
    object_labels: List[str] = Field(
        default_factory=list, validation_alias=AliasChoices("objectLabels", "labels")
    )


class ChatRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    message: str = Field(validation_alias=AliasChoices("message", "msg"))
    conversation_history: List[ChatMessage] = Field(
        default_factory=list,
        validation_alias=AliasChoices("conversationHistory", "history", "messages"),
    )
    witness_persona: WitnessPersona = Field(
        validation_alias=AliasChoices("witnessPersona", "persona")
    )
    scene_objects: List[SceneObject] = Field(
        default_factory=list, validation_alias=AliasChoices("sceneObjects", "objects")
    )


class ChatResponse(BaseModel):
    reply: str
    conversationHistory: List[ChatMessage]


class VerdictRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    accusation: Accusation = Field(validation_alias=AliasChoices("accusation", "theory"))
    witness_persona: WitnessPersona = Field(
        validation_alias=AliasChoices("witnessPersona", "persona")
    )
    scene_objects: List[SceneObject] = Field(
        default_factory=list, validation_alias=AliasChoices("sceneObjects", "objects")
    )


class CaseFileRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    conversation_history: List[ChatMessage] = Field(
        default_factory=list,
        validation_alias=AliasChoices("conversationHistory", "history", "messages"),
    )
    witness_persona: WitnessPersona = Field(
        validation_alias=AliasChoices("witnessPersona", "persona")
    )


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/scan", response_model=ScanResponse)
async def scan_scene(request: ScanRequest) -> ScanResponse:
    image_base64 = _normalize_base64(request.image_base64)
    if not image_base64:
        raise HTTPException(status_code=400, detail="Missing base64 image data.")

    messages = [
        {"role": "system", "content": PROMPT_1},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Analyze this image."},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                },
            ],
        },
    ]

    try:
        response_text = await call_llm(
            messages=messages,
            model=_model_for("scan"),
            json_mode=True,
            temperature=0.2,
        )
        payload = _extract_json(response_text)
        return ScanResponse.model_validate(payload)
    except (LLMError, json.JSONDecodeError, ValueError) as exc:
        logger.exception("Scan failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/persona", response_model=WitnessPersona)
async def generate_persona(request: PersonaRequest) -> WitnessPersona:
    labels = request.object_labels or [obj.label for obj in request.scene_objects]
    label_text = ", ".join(labels) if labels else "(no objects provided)"
    prompt = PROMPT_2.replace("[INJECT: objects array as comma-separated labels]", label_text)

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Generate the witness persona."},
    ]

    try:
        response_text = await call_llm(
            messages=messages,
            model=_model_for("persona"),
            json_mode=True,
            temperature=0.6,
        )
        payload = _extract_json(response_text)
        return WitnessPersona.model_validate(payload)
    except (LLMError, json.JSONDecodeError, ValueError) as exc:
        logger.exception("Persona generation failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    persona = request.witness_persona
    labels = [obj.label for obj in request.scene_objects]
    prompt = PROMPT_3_TEMPLATE.format(
        name=persona.name,
        archetype=persona.archetype,
        age=persona.age,
        occupation=persona.occupation,
        object_labels=", ".join(labels) if labels else "(no objects provided)",
        secret=persona.secret,
        guilty_of=persona.guiltyOf,
        tells=json.dumps(persona.tells),
        speaking_style=persona.speakingStyle,
    )

    history = _normalize_history(request.conversation_history)
    messages = [{"role": "system", "content": prompt}]
    messages.extend(_history_to_messages(history))
    messages.append({"role": "user", "content": request.message})

    try:
        response_text = await call_llm(
            messages=messages,
            model=_model_for("chat"),
            json_mode=False,
            temperature=0.6,
        )
    except LLMError as exc:
        logger.exception("Chat failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    updated_history = history + [ChatMessage(role="user", content=request.message)]
    updated_history.append(ChatMessage(role="model", content=response_text.strip()))

    return ChatResponse(reply=response_text.strip(), conversationHistory=updated_history)


@app.post("/api/verdict", response_model=Verdict)
async def verdict(request: VerdictRequest) -> Verdict:
    persona = request.witness_persona
    flagged = [obj.label for obj in request.scene_objects if obj.flagged]
    evidence_text = ", ".join(flagged) if flagged else "none detected"

    prompt = PROMPT_8_TEMPLATE.format(
        suspect=request.accusation.suspect,
        method=request.accusation.method,
        motive=request.accusation.motive,
        guilty_of=persona.guiltyOf,
        secret=persona.secret,
        evidence=evidence_text,
    )

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Return the verdict JSON."},
    ]

    try:
        response_text = await call_llm(
            messages=messages,
            model=_model_for("verdict"),
            json_mode=True,
            temperature=0.4,
        )
        payload = _extract_json(response_text)
        return Verdict.model_validate(payload)
    except (LLMError, json.JSONDecodeError, ValueError) as exc:
        logger.exception("Verdict failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/casefile", response_model=CaseFile)
async def casefile(request: CaseFileRequest) -> CaseFile:
    persona = request.witness_persona
    normalized_history = _normalize_history(request.conversation_history)
    history_json = json.dumps([msg.model_dump() for msg in normalized_history])

    prompt = PROMPT_9_TEMPLATE.format(
        conversation_history=history_json,
        guilty_of=persona.guiltyOf,
        secret=persona.secret,
    )

    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Return the case file JSON."},
    ]

    try:
        response_text = await call_llm(
            messages=messages,
            model=_model_for("casefile"),
            json_mode=True,
            temperature=0.4,
        )
        payload = _extract_json(response_text)
        return CaseFile.model_validate(payload)
    except (LLMError, json.JSONDecodeError, ValueError) as exc:
        logger.exception("Case file failed")
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}
