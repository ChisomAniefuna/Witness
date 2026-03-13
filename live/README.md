# Witness Live (ADK Gemini Live)

FastAPI WebSocket service for real-time voice interrogation of the Witness agent. Uses [Google ADK](https://github.com/google/adk) with the Gemini Live API (Bidi streaming).

## Architecture (ADK pattern)

- **Application**: This FastAPI app, test UI (`/test-live`), and frontend hook own the transport and agent definition.
- **Orchestration**: ADK `Runner`, `LiveRequestQueue`, and LLM Flow handle session lifecycle, message ordering, and protocol translation.
- **AI**: Gemini Live API (native audio model) provides real-time, low-latency voice with VAD and transcription.

**Seamless conversation (per official Bidi docs):** We use the Live API’s **automatic Voice Activity Detection (VAD)** so turn-taking is natural—you speak, pause when done, and the model responds. No client-side activity signals; the server detects when you finish speaking. You can interrupt the witness anytime (client stops playback on `interrupted`). Input is sent in **30 ms** chunks; playback uses a **120 ms** buffer.

**Audio specs:**

| Direction | Format | Notes |
|-----------|--------|--------|
| Input (mic → model) | 16-bit PCM, mono, 16 kHz | 30 ms chunks. Stream continuously; server VAD detects end of speech. |
| Output (model → playback) | 16-bit PCM, mono, 24 kHz | 120 ms buffer on the client. |

## References

- **Official Bidi docs** – `resources/Bidi_docs.txt` in this repo (Google docs). Defines seamless Bidi flow, automatic VAD, interruption, and the four-phase lifecycle.
- **ADK Gemini Live API Toolkit Development Guide** – 5-part series (and the **bidi-demo**); see **live/BIDI_DEMO_REFERENCE.md** for how Witness Live aligns and what we add (init, persona).
- **ADK docs** – Agent design, tools, session management, deployment.

## Run locally

```bash
cd live
python -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env        # set GOOGLE_API_KEY or GOOGLE_GENAI_API_KEY
python -m uvicorn app.main:app --host 0.0.0.0 --port 8081
```

- **Health**: [http://localhost:8081/health](http://localhost:8081/health)
- **Test harness**: [http://localhost:8081/test-live](http://localhost:8081/test-live) – connect, init, then use mic or text.

## WebSocket protocol

1. Client connects to `ws://localhost:8081/live`.
2. Server sends `{ "type": "connected", "message": "..." }`.
3. Client sends **init**: `{ "type": "init", "persona": {...}, "objectLabels": [...] }`.
4. Server sends `{ "type": "init_ack", "message": "..." }`.
5. Client sends **audio**: `{ "type": "audio", "data": "<base64 PCM 16kHz>" }` (stream continuously) and/or **text**: `{ "type": "text", "text": "..." }`. Server uses automatic VAD to detect when you stop speaking.
6. Server streams ADK events as JSON (content with parts, transcriptions, interrupted, turn_complete, etc.). Client stops witness playback when `interrupted: true`.

**Note:** If the server logs `1008 (policy violation)` and the session drops, the Live API or model may not be enabled for your project or key; check Google AI Studio / Cloud and the model allowlist.
