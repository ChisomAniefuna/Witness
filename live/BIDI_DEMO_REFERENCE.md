# Witness Live vs Official Bidi docs and bidi-demo

This doc maps **Witness Live** to the **official Bidi docs** (`resources/Bidi_docs.txt`) and the **bidi-demo** so we keep conversation seamless and aligned with Google’s patterns.

## Seamless conversation (per official Bidi docs)

The Bidi docs state: *"Voice Activity Detection (VAD): Automatically detects when users finish speaking, enabling natural turn-taking without explicit signals. The AI knows when to start responding and when to wait for more input."*

We use **automatic VAD** (default): the client only streams audio; the Live API detects when the user stops speaking. No `activity_start` / `activity_end` from the client. This matches the doc’s intended seamless, phone-call-like flow. Interruption is handled: when the user speaks over the witness, the client receives `interrupted: true`, stops playback, and the model pivots to the new input.

## What we follow (same as bidi-demo / Bidi docs)

- **Phase 1 – Application init:** One `Runner` + `SessionService` at app scope; agent is created per session from init payload (Witness persona).
- **Phase 2 – Session init:** Get-or-create `Session`; session-scoped `RunConfig` and `LiveRequestQueue`; **no** `realtime_input_config` (so automatic VAD is on).
- **Phase 3 – Bidi-streaming:** Upstream: receive WebSocket → `send_content()` / `send_realtime()`. Downstream: `run_live()` → `event.model_dump_json(exclude_none=True, by_alias=True)` → WebSocket.
- **Phase 4 – Termination:** `finally: live_request_queue.close()`.
- **RunConfig:** `StreamingMode.BIDI`, `response_modalities=["AUDIO"]`, transcription configs, `session_resumption=types.SessionResumptionConfig()`.

## What we add (Witness-specific)

- **Init handshake:** Client sends `{ "type": "init", "persona", "objectLabels" }` first; we build the Witness agent and then start the run.
- **Upstream message types:** `audio` (base64 PCM 16 kHz), `text` only (no activity signals).
- **Interruption:** Client stops witness audio on `interrupted: true` (player `stop()`); App passes `onInterrupted` to the hook.
- **Error handling:** Catch `GenaiAPIError`, `ConnectionClosed`, and `RuntimeError` (closed WebSocket) in downstream; log a short warning for 1008.

## References

- **Official Bidi docs:** `resources/Bidi_docs.txt` – seamless flow, automatic VAD, interruption, four-phase lifecycle, RunConfig.
- **bidi-demo:** `resources/bidi-demo/implementation_notes.txt` – concrete code patterns.
- **Web:** ADK Gemini Live API Toolkit Development Guide (Parts 1–5).
