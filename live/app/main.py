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

from collections import defaultdict
from dotenv import load_dotenv  # pyright: ignore[reportMissingImports]
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect  # pyright: ignore[reportMissingImports]
from fastapi.middleware.cors import CORSMiddleware  # pyright: ignore[reportMissingImports]
from fastapi.responses import FileResponse, Response  # pyright: ignore[reportMissingImports]
from slowapi import Limiter, _rate_limit_exceeded_handler  # pyright: ignore[reportMissingImports]
from slowapi.util import get_remote_address  # pyright: ignore[reportMissingImports]
from slowapi.errors import RateLimitExceeded  # pyright: ignore[reportMissingImports]
from google.genai import types  # pyright: ignore[reportMissingImports]
from google.genai.errors import APIError as GenaiAPIError  # pyright: ignore[reportMissingImports]
from google.adk.agents.live_request_queue import LiveRequestQueue  # pyright: ignore[reportMissingImports]
from websockets.exceptions import ConnectionClosed  # pyright: ignore[reportMissingImports]
from google.adk.agents.run_config import RunConfig, StreamingMode  # pyright: ignore[reportMissingImports]
from google.adk.runners import Runner  # pyright: ignore[reportMissingImports]
from google.adk.sessions import InMemorySessionService  # pyright: ignore[reportMissingImports]

from app.witness_agent.agent import build_witness_instructions, create_witness_agent
from app.witness_agent.agent import WITNESS_LIVE_MODEL

# Load .env from live/ so it works whether we run from repo root or live/
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path)
# google-genai SDK expects GOOGLE_API_KEY; accept GOOGLE_GENAI_API_KEY too
if not os.getenv("GOOGLE_API_KEY") and os.getenv("GOOGLE_GENAI_API_KEY"):
    os.environ["GOOGLE_API_KEY"] = os.environ["GOOGLE_GENAI_API_KEY"]
logger = logging.getLogger(__name__)
logger.info("Witness Live model: %s", WITNESS_LIVE_MODEL)

APP_NAME = "witness-live"
USER_ID_MVP = "witness-user"

# One in-memory session service for all connections (sessions die when connection closes)
session_service = InMemorySessionService()

# Rate limiting: HTTP by IP; WebSocket max concurrent connections per IP
limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="Witness Live", version="0.1.0")
app.state.limiter = limiter


def rate_limit_exceeded_handler(request: Request, exc: Exception) -> Response:
    if isinstance(exc, RateLimitExceeded):
        return _rate_limit_exceeded_handler(request, exc)
    raise exc


app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

# Per-IP concurrent WebSocket connection count (protect key from abuse)
ws_connections_per_ip: dict[str, int] = defaultdict(int)
WS_MAX_PER_IP = 3

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
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    """This service is the voice API only. The app is hosted separately (e.g. Firebase Hosting)."""
    return {
        "service": "witness-live",
        "message": "Voice API only. Use the main app URL to play. Endpoints: /health, /test-live (harness), /live (WebSocket).",
        "endpoints": {"health": "/health", "test_harness": "/test-live", "websocket": "/live"},
    }


@app.get("/health")
@limiter.limit("60/minute")
async def health(request: Request):
    return {"status": "ok", "service": "witness-live"}


@app.get("/test-live")
@limiter.limit("30/minute")
async def test_live_page(request: Request):
    """Serve a minimal test UI to exercise the Live WebSocket without the full app."""
    _live_root = Path(__file__).resolve().parent.parent
    path = _live_root / "test_live.html"
    if not path.is_file():
        from fastapi import HTTPException  # pyright: ignore[reportMissingImports]
        raise HTTPException(status_code=404, detail="test_live.html not found")
    return FileResponse(path, media_type="text/html")


@app.websocket("/live")
async def websocket_live(websocket: WebSocket):
    client_ip = websocket.client.host if websocket.client else "unknown"
    if ws_connections_per_ip[client_ip] >= WS_MAX_PER_IP:
        await websocket.close(code=1008, reason="Too many concurrent voice sessions from this IP")
        return
    ws_connections_per_ip[client_ip] += 1
    try:
        await websocket.accept()
    except Exception:
        ws_connections_per_ip[client_ip] -= 1
        raise
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
        response_modalities=[types.Modality.AUDIO],
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
    )
    live_request_queue = LiveRequestQueue()

    await websocket.send_text(
        json.dumps({"type": "init_ack", "message": "Session initialized. You can send audio or text."})
    )

    async def upstream_task():
        """Receives messages from WebSocket and forwards to LiveRequestQueue.
        Audio is sent as raw binary frames (PCM 16kHz 16-bit LE) matching the bidi-demo reference.
        Text commands (init_ack, text) are sent as JSON text frames."""
        audio_chunk_count = 0
        try:
            while True:
                message = await websocket.receive()

                # Binary frame → raw PCM audio (preferred path, matches bidi-demo)
                if "bytes" in message:
                    audio_bytes = message["bytes"]
                    if audio_bytes:
                        blob = types.Blob(
                            mime_type="audio/pcm;rate=16000",
                            data=audio_bytes,
                        )
                        live_request_queue.send_realtime(blob)
                        audio_chunk_count += 1
                        if audio_chunk_count <= 3 or audio_chunk_count % 50 == 0:
                            logger.info("Audio received (binary): chunk #%s, %s bytes", audio_chunk_count, len(audio_bytes))

                # Text frame → JSON command (text message or legacy base64 audio)
                elif "text" in message:
                    raw = message["text"]
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    t = data.get("type")
                    if t == "text":
                        text = data.get("text", "")
                        if text:
                            content = types.Content(parts=[types.Part(text=text)])
                            live_request_queue.send_content(content)
                    elif t == "audio":
                        # Legacy fallback: base64-encoded audio in JSON
                        b64 = data.get("data")
                        if b64:
                            try:
                                audio_bytes = base64.b64decode(b64)
                                blob = types.Blob(mime_type="audio/pcm;rate=16000", data=audio_bytes)
                                live_request_queue.send_realtime(blob)
                            except Exception as e:
                                logger.warning("Legacy audio decode failed: %s", e)
        except WebSocketDisconnect:
            logger.debug("Client disconnected (upstream)")
        except RuntimeError as e:
            if "disconnect" in str(e).lower():
                logger.debug("Client disconnected (upstream, RuntimeError): %s", e)
            else:
                logger.exception("Upstream task RuntimeError: %s", e)
        except asyncio.CancelledError:
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
            # Notify client of error and close WebSocket so it can recover cleanly.
            try:
                error_payload = {
                    "type": "error",
                    "message": "Live API connection closed",
                    "detail": str(e),
                }
                await websocket.send_text(json.dumps(error_payload))
            except Exception:
                # Ignore failures while attempting to notify the client.
                logger.debug("Failed to send downstream error message to client", exc_info=True)
            try:
                await websocket.close()
            except Exception:
                logger.debug("Failed to close WebSocket after downstream error", exc_info=True)
        except Exception as e:
            logger.exception("Downstream task error: %s", e)
            # Notify client of error and close WebSocket so it can recover cleanly.
            try:
                error_payload = {
                    "type": "error",
                    "message": "Downstream task error",
                    "detail": str(e),
                }
                await websocket.send_text(json.dumps(error_payload))
            except Exception:
                logger.debug("Failed to send downstream error message to client", exc_info=True)
            try:
                await websocket.close()
            except Exception:
                logger.debug("Failed to close WebSocket after downstream error", exc_info=True)

    try:
        await asyncio.gather(upstream_task(), downstream_task(), return_exceptions=True)
    except asyncio.CancelledError:
        # Normal when the server is stopping.
        pass
    except Exception as e:
        logger.exception("Streaming error: %s", e)
    finally:
        live_request_queue.close()
        ws_connections_per_ip[client_ip] = max(0, ws_connections_per_ip[client_ip] - 1)
        logger.debug("Closed queue for session %s", session_id)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8081"))
    import uvicorn  # pyright: ignore[reportMissingImports]
    uvicorn.run(app, host="0.0.0.0", port=port)
