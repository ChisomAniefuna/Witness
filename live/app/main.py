"""
Witness Live service: FastAPI WebSocket endpoint for bidirectional voice interrogation.
Uses ADK Runner + LiveRequestQueue + run_live; init message injects persona + objectLabels into agent instructions.

Architecture follows the ADK Gemini Live API Toolkit pattern:
- Upstream: client sends audio (16-bit PCM 16kHz, 50–100ms chunks) and text via WebSocket → LiveRequestQueue.send_realtime / send_content.
- Downstream: run_live() yields events (audio inline_data 24kHz, transcriptions, turn_complete) → forwarded to client.
See resources/Bidi_docs.txt (official Bidi docs) for seamless flow and VAD; ADK guide and bidi-demo for implementation.
"""
import asyncio
import base64
import json
import logging
import os
import uuid

from pathlib import Path

from dotenv import load_dotenv  # pyright: ignore[reportMissingImports]
from fastapi import FastAPI, WebSocket, WebSocketDisconnect  # pyright: ignore[reportMissingImports]
from fastapi.middleware.cors import CORSMiddleware  # pyright: ignore[reportMissingImports]
from fastapi.responses import FileResponse  # pyright: ignore[reportMissingImports]
from google.genai import types  # pyright: ignore[reportMissingImports]
from google.genai.errors import APIError as GenaiAPIError  # pyright: ignore[reportMissingImports]
from google.adk.agents.live_request_queue import LiveRequestQueue  # pyright: ignore[reportMissingImports]
from websockets.exceptions import ConnectionClosed  # pyright: ignore[reportMissingImports]
from google.adk.agents.run_config import RunConfig, StreamingMode  # pyright: ignore[reportMissingImports]
from google.adk.runners import Runner  # pyright: ignore[reportMissingImports]
from google.adk.sessions import InMemorySessionService  # pyright: ignore[reportMissingImports]

from app.witness_agent.agent import build_witness_instructions, create_witness_agent

# Load .env from live/ so it works whether we run from repo root or live/
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)
# google-genai SDK expects GOOGLE_API_KEY; accept GOOGLE_GENAI_API_KEY too
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GOOGLE_GENAI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GOOGLE_GENAI_API_KEY"]
logger = logging.getLogger(__name__)

APP_NAME = "witness-live"
USER_ID_MVP = "witness-user"

# One in-memory session service for all connections (sessions die when connection closes)
session_service = InMemorySessionService()

app = FastAPI(title="Witness Live", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    # WebSockets don't use CORS the same way as fetch, but we keep this permissive for local dev UX
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://0.0.0.0:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "witness-live"}


@app.get("/test-live")
async def test_live_page():
    """Serve a minimal test UI to exercise the Live WebSocket without the full app."""
    _live_root = Path(__file__).resolve().parent.parent
    path = _live_root / "test_live.html"
    if not path.is_file():
        from fastapi import HTTPException  # pyright: ignore[reportMissingImports]
        raise HTTPException(status_code=404, detail="test_live.html not found")
    return FileResponse(path, media_type="text/html")


@app.websocket("/live")
async def websocket_live(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())

    # Send connected so client can verify
    await websocket.send_text(
        json.dumps({
            "type": "connected",
            "message": "Witness Live WebSocket connected. Send init with persona and objectLabels.",
            "session_id": session_id,
        })
    )

    # Must receive init before starting ADK
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
    except asyncio.TimeoutError:
        await websocket.send_text(json.dumps({"type": "error", "message": "Timeout waiting for init"}))
        await websocket.close()
        return

    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        await websocket.send_text(json.dumps({"type": "error", "message": "Invalid JSON"}))
        await websocket.close()
        return

    if msg.get("type") != "init":
        await websocket.send_text(json.dumps({"type": "error", "message": "First message must be type: init"}))
        await websocket.close()
        return

    persona = msg.get("persona") or {}
    object_labels = msg.get("objectLabels") or []
    instructions = build_witness_instructions(persona, object_labels)
    agent = create_witness_agent(instructions)
    runner = Runner(
        app_name=APP_NAME,
        agent=agent,
        session_service=session_service,
    )

    # Get or create session
    session = await session_service.get_session(
        app_name=APP_NAME,
        user_id=USER_ID_MVP,
        session_id=session_id,
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME,
            user_id=USER_ID_MVP,
            session_id=session_id,
        )

    # Use default automatic VAD for seamless turn-taking (per official Bidi docs:
    # "Voice Activity Detection: Automatically detects when users finish speaking, enabling natural turn-taking without explicit signals.")
    run_config = RunConfig(
        streaming_mode=StreamingMode.BIDI,
        response_modalities=["AUDIO"],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        session_resumption=types.SessionResumptionConfig(),
    )
    live_request_queue = LiveRequestQueue()

    await websocket.send_text(
        json.dumps({"type": "init_ack", "message": "Session initialized. You can send audio or text."})
    )

    async def upstream_task():
        audio_chunk_count = 0
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                t = data.get("type")
                if t == "audio":
                    b64 = data.get("data")
                    if b64:
                        try:
                            audio_bytes = base64.b64decode(b64)
                            blob = types.Blob(
                                mime_type="audio/pcm;rate=16000",
                                data=audio_bytes,
                            )
                            live_request_queue.send_realtime(blob)
                            audio_chunk_count += 1
                            if audio_chunk_count <= 3 or audio_chunk_count % 50 == 0:
                                logger.info("Audio received: chunk #%s, %s bytes", audio_chunk_count, len(audio_bytes))
                        except Exception as e:
                            logger.warning("Audio decode/send_realtime failed: %s", e)
                elif t == "text":
                    text = data.get("text", "")
                    if text:
                        content = types.Content(parts=[types.Part(text=text)])
                        live_request_queue.send_content(content)
        except WebSocketDisconnect:
            logger.debug("Client disconnected (upstream)")
        except asyncio.CancelledError:
            # Normal during server shutdown / task cancellation.
            return
        except Exception as e:
            logger.exception("Upstream task error: %s", e)

    async def downstream_task():
        try:
            event_count = 0
            async for event in runner.run_live(
                user_id=USER_ID_MVP,
                session_id=session_id,
                live_request_queue=live_request_queue,
                run_config=run_config,
            ):
                event_count += 1
                event_json = event.model_dump_json(exclude_none=True, by_alias=True)
                try:
                    await websocket.send_text(event_json)
                except RuntimeError:
                    break
                if event_count <= 5 or (event_count % 25 == 0):
                    has_parts = getattr(event, "content", None) and getattr(event.content, "parts", None)
                    has_out_trans = getattr(event, "output_transcription", None) or getattr(event, "input_transcription", None)
                    if has_parts or has_out_trans:
                        logger.info("Event #%s: has_parts=%s, has_transcription=%s", event_count, bool(has_parts), bool(has_out_trans))
        except asyncio.CancelledError:
            # Normal during server shutdown / task cancellation.
            return
        except (GenaiAPIError, ConnectionClosed) as e:
            logger.warning(
                "Live API connection closed: %s (code 1008 often means model/feature not enabled for this key or policy).",
                e,
            )
        except Exception as e:
            logger.exception("Downstream task error: %s", e)

    try:
        await asyncio.gather(upstream_task(), downstream_task(), return_exceptions=True)
    except asyncio.CancelledError:
        # Normal when the server is stopping.
        pass
    except Exception as e:
        logger.exception("Streaming error: %s", e)
    finally:
        live_request_queue.close()
        logger.debug("Closed queue for session %s", session_id)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8081"))
    import uvicorn  # pyright: ignore[reportMissingImports]
    uvicorn.run(app, host="0.0.0.0", port=port)
