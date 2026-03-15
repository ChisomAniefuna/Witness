/**
 * Hook for Witness Live WebSocket: connect to Python ADK Bidi service,
 * send init (persona + objectLabels), stream audio/text and receive events.
 * Mic capture: 16 kHz mono PCM, chunks sent as base64 over WebSocket.
 * See ADK Gemini Live API Toolkit guide: input 16-bit PCM 16kHz, 50–100ms chunks; output 24kHz.
 */
import { useCallback, useRef, useState } from 'react';

const SAMPLE_RATE_TARGET = 16000;
const SAMPLE_RATE_DEFAULT = 48000;
/** 20ms chunks for slightly lower latency (server gets audio sooner). */
const CHUNK_MS = 20;

/** Downsample Float32Array (e.g. 48k) to 16k and convert to Int16 PCM. */
function toPcm16k(float32: Float32Array, sourceSampleRate: number): ArrayBuffer {
  const ratio = sourceSampleRate / SAMPLE_RATE_TARGET;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s = idx + 1 < float32.length
      ? float32[idx]! * (1 - frac) + float32[idx + 1]! * frac
      : float32[idx]!;
    const v = Math.max(-1, Math.min(1, s));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out.buffer;
}

/** Base64 encode ArrayBuffer. */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Parse sample rate from mime type e.g. "audio/pcm;rate=24000" -> 24000 */
function parsePcmRate(mimeType?: string): number {
  if (!mimeType) return 24000;
  const m = mimeType.match(/rate=(\d+)/i);
  return m ? parseInt(m[1]!, 10) : 24000;
}

const META_PHRASES = [
  "i'm taking on",
  "i've formulated",
  "i'm trying to address",
  "i'm now zeroing",
  "the goal is to",
  "it feels appropriately",
  "this is a delicate",
  "i'm keeping my persona",
  "i'm focusing on",
  "formulated a response",
  "taking on the role",
  "i've established the scenario",
  "i've developed the initial",
  "i settled on:",
  "crafting the initial",
  "i'm focused on the user",
  "my primary strategy",
  "question is still echoing",
  "i'm employing the",
  "i'm touching my glasses",
  "i am happy with the current outcome",
  "the detective's greeting requires",
  "the clipped delivery",
  "establishing finch's",
  "the greeting has been received",
  "i've responded as leo finch",
  "maintaining clipped evasion",
  "the character acknowledges",
  "i am keeping to the persona",
  "here's what i've got",
  "priority one",
  "adopting leo finch",
  "my response needs to be",
  "i'll highlight my work",
  "i'm analyzing",
  "i have to be evasive",
  "stick to my cover story",
  "i'm still dancing around",
  "i must keep deflecting",
  "i will try to display",
  "i'm focused on navigating",
  "my current strategy",
  "feigning discomfort",
  "body language such as",
  "clears throat",
  "touching my glasses",
  "enhance my performance",
  "steer the conversation",
];

/** Strip leading **Label**, stage directions *...*, meta sentences, and extract quoted dialogue. */
function stripWitnessLabels(text: string): string {
  let s = text.replace(/^\s*\*\*[^*]+\*\*\s*/g, '').trim();
  s = s.replace(/\s*\*[^*]*\*\s*/g, ' ').trim();
  const quoted =
    /(?:formulated a response|settled on|I settled on):\s*["\u201C]([^"\u201D]+)["\u201D]/i.exec(s) ??
    /response:\s*["\u201C]([^"\u201D]+)["\u201D]/i.exec(s);
  if (quoted?.[1]) s = quoted[1].trim();
  const sentences = s.split(/(?<=[.!?])\s+/).filter((sent) => {
    const lower = sent.toLowerCase();
    return !META_PHRASES.some((p) => lower.includes(p));
  });
  return sentences.join(' ').replace(/\s+/g, ' ').trim() || s;
}

/** Decode audio data from base64 string or byte array; returns null if invalid. */
function decodeAudioData(data: string | number[]): ArrayBuffer | null {
  if (typeof data === 'string') {
    const s = data.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
    try {
      const binary = atob(s);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    } catch {
      return null;
    }
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data).buffer;
  }
  return null;
}

// Lower buffer reduces "initial silence" before speech starts; we also flush on turn_complete.
const MIN_BUFFER_MS = 30;

/** Create a simple queue-based PCM player for witness audio (e.g. 24 kHz from Gemini). Buffers ~100ms to reduce crackling. */
export function createLiveAudioPlayer(): {
  playChunk: (data: string | number[], mimeType?: string) => void;
  /** Flush any buffered audio (call when ending the session so the last chunk plays). */
  flush: () => void;
  /** Stop playback and clear queue (call when user interrupts so witness stops immediately). */
  stop: () => void;
} {
  let queue: { buffer: ArrayBuffer; sampleRate: number }[] = [];
  let playing = false;
  let ctx: AudioContext | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  const accumulator: { buffers: ArrayBuffer[]; totalBytes: number; sampleRate: number } = {
    buffers: [],
    totalBytes: 0,
    sampleRate: 24000,
  };

  function flushAccumulator(): void {
    if (accumulator.buffers.length === 0) return;
    const total = accumulator.totalBytes;
    const rate = accumulator.sampleRate;
    const merged = new ArrayBuffer(total);
    const view = new Uint8Array(merged);
    let off = 0;
    for (const b of accumulator.buffers) {
      view.set(new Uint8Array(b), off);
      off += b.byteLength;
    }
    accumulator.buffers = [];
    accumulator.totalBytes = 0;
    queue.push({ buffer: merged, sampleRate: rate });
    if (!playing) playNext();
  }

  function playNext(): void {
    if (queue.length === 0) {
      playing = false;
      currentSource = null;
      return;
    }
    const { buffer, sampleRate } = queue.shift()!;
    if (!buffer || buffer.byteLength === 0) {
      playNext();
      return;
    }
    if (!ctx) ctx = new AudioContext({ sampleRate });
    // Resume if suspended (browser autoplay policy)
    if (ctx.state === 'suspended') ctx.resume();
    const int16 = new Int16Array(buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i]! / (int16[i]! < 0 ? 0x8000 : 0x7fff);
    const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.getChannelData(0).set(float32);
    const source = ctx.createBufferSource();
    currentSource = source;
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = () => playNext();
    source.start(0);
    playing = true;
  }

  function stopPlayback(): void {
    if (currentSource) try { currentSource.stop(); } catch (_) {}
    currentSource = null;
    queue.length = 0;
    accumulator.buffers = [];
    accumulator.totalBytes = 0;
    playing = false;
    if (ctx) {
      try {
        // Close the AudioContext to release audio resources and allow GC.
        ctx.close().catch(() => {});
      } catch (_) {
        // Ignore errors if the context is already closed or in an invalid state.
      } finally {
        ctx = null;
      }
    }
  }

  function playChunk(data: string | number[], mimeType?: string): void {
    const buffer = decodeAudioData(data);
    if (!buffer || buffer.byteLength === 0) return;
    const sampleRate = parsePcmRate(mimeType);
    accumulator.buffers.push(buffer);
    accumulator.totalBytes += buffer.byteLength;
    accumulator.sampleRate = sampleRate;
    const minBytes = Math.floor(sampleRate * (MIN_BUFFER_MS / 1000) * 2);
    if (accumulator.totalBytes >= minBytes) flushAccumulator();
  }

  return { playChunk, flush: flushAccumulator, stop: stopPlayback };
}

export interface WitnessPersonaForLive {
  name: string;
  archetype: string;
  age: number;
  occupation: string;
  tells: string[];
  openingStatement?: string;
  guiltyOf: string;
  secret: string;
  speakingStyle?: string;
}

export interface UseWitnessLiveOptions {
  /** Called when a final user transcript is received (input_audio_transcription). */
  onUserTranscript?: (text: string) => void;
  /** Called when a final witness transcript is received (output_audio_transcription). */
  onWitnessTranscript?: (text: string) => void;
  /** Called when audio bytes (base64) are received for playback. */
  onAudioChunk?: (data: string | number[], mimeType?: string) => void;
  /** Called when raw ADK event is received (for debugging or custom handling). */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Called when the user interrupted (event.interrupted). Use to stop witness audio playback. */
  onInterrupted?: () => void;
  /** Called when the backend session is ready (after init_ack). */
  onReady?: () => void;
  /** Called when a model turn completes; useful to flush any buffered audio. */
  onTurnComplete?: () => void;
}

function getLiveWsUrl(): string {
  const env = import.meta.env.VITE_LIVE_WS_URL as string | undefined;
  if (env) {
    const url = env.startsWith('ws') ? env : `ws://${env.replace(/^https?:\/\//, '')}`;
    return url.endsWith('/live') ? url : `${url.replace(/\/$/, '')}/live`;
  }
  // Prefer same-origin /live (works with Vite proxy in dev and with reverse-proxy in prod).
  try {
    const { protocol, host } = window.location;
    const wsProto = protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${host}/live`;
  } catch {
    return 'ws://localhost:8081/live';
  }
}


export function useWitnessLive(options: UseWitnessLiveOptions = {}) {
  const { onUserTranscript, onWitnessTranscript, onAudioChunk, onEvent, onInterrupted, onReady, onTurnComplete } = options;
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'listening' | 'witness_speaking'>('idle');
  const statusRef = useRef<'idle' | 'connecting' | 'listening' | 'witness_speaking'>('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const initSentRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const enableMicRef = useRef(false);
  const sendAudioRef = useRef<(base64: string) => void>(() => {});
  const lastLocalInterruptMsRef = useRef(0);

  const setStatusSafe = useCallback((next: typeof statusRef.current) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopLive = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    initSentRef.current = false;
    setConnected(false);
    setStatusSafe('idle');
    setError(null);
  }, [setStatusSafe]);

  const startMicCapture = useCallback((sendAudioChunk: (base64: string) => void) => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        mediaStreamRef.current = stream;
        const ctx = new AudioContext({ sampleRate: SAMPLE_RATE_DEFAULT });
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const bufferSize = 4096;
        const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
        processorRef.current = processor;
        let buffer: number[] = [];
        const samplesPerChunk = Math.floor((SAMPLE_RATE_TARGET / 1000) * CHUNK_MS);
        processor.onaudioprocess = (e) => {
          const input = e.inputBuffer.getChannelData(0);
          // Local barge-in: if the witness is speaking and we detect user speech, stop playback immediately.
          // This avoids waiting for a server-side "interrupted" event which can arrive late.
          let maxAbs = 0;
          for (let i = 0; i < input.length; i++) {
            const v = Math.abs(input[i]!);
            if (v > maxAbs) maxAbs = v;
          }
          const now = Date.now();
          if (
            statusRef.current === 'witness_speaking' &&
            maxAbs > 0.08 &&
            now - lastLocalInterruptMsRef.current > 500
          ) {
            lastLocalInterruptMsRef.current = now;
            onInterrupted?.();
            setStatusSafe('listening');
          }
          for (let i = 0; i < input.length; i++) buffer.push(input[i]!);
          const sr = ctx.sampleRate;
          while (buffer.length >= (sr / SAMPLE_RATE_TARGET) * samplesPerChunk) {
            const take = Math.floor((sr / SAMPLE_RATE_TARGET) * samplesPerChunk);
            const chunk = new Float32Array(buffer.splice(0, take));
            const pcm = toPcm16k(chunk, sr);
            sendAudioChunk(toBase64(pcm));
          }
        };
        source.connect(processor);
        processor.connect(ctx.destination);
      })
      .catch((err) => {
        console.error('useWitnessLive: mic error', err);
        // Reflect mic failure in hook state so UI can show actionable feedback.
        setError(err instanceof Error ? err.message : 'Microphone access failed. Please check permissions and input device.');
        setStatusSafe('idle');
        if (enableMicRef && 'current' in enableMicRef) {
          enableMicRef.current = false;
        }
      });
  }, [onInterrupted, setStatusSafe]);

  const startLive = useCallback(
    (persona: WitnessPersonaForLive, objectLabels: string[], enableMic = false) => {
      stopLive();
      enableMicRef.current = enableMic;
      setError(null);
      setStatusSafe('connecting');
      const wsUrl = getLiveWsUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      sendAudioRef.current = (base64: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio', data: base64 }));
      };

      ws.onopen = () => {
        setConnected(true);
        setError(null);
        setStatusSafe('listening');
        const init = {
          type: 'init',
          persona,
          objectLabels,
        };
        ws.send(JSON.stringify(init));
        initSentRef.current = true;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string) as Record<string, unknown>;
          const msgType = data.type as string | undefined;
          onEvent?.(data);

          if (data.interrupted === true) {
            onInterrupted?.();
            setStatusSafe('listening');
          }

          if (msgType === 'connected' || msgType === 'init_ack') {
            setStatusSafe('listening');
            if (msgType === 'init_ack') {
              onReady?.();
              if (enableMicRef.current) startMicCapture(sendAudioRef.current);
            }
            return;
          }
          if (msgType === 'error') {
            setError((data.message as string) || 'Unknown error');
            return;
          }

          // ADK Event: support both snake_case and camelCase (model_dump_json by_alias)
          const inputTrans = (data.input_transcription ?? data.inputAudioTranscription) as
            | { final_transcript?: string; transcript?: string; text?: string; finalTranscript?: string; partial?: boolean }
            | undefined;
          const outputTrans = (data.output_transcription ?? data.outputAudioTranscription) as
            | { final_transcript?: string; transcript?: string; text?: string; finalTranscript?: string }
            | undefined;
          const content = data.content as {
            parts?: Array<{
              text?: string;
              inline_data?: { data?: string; mime_type?: string };
              inlineData?: { data?: string; mimeType?: string; mime_type?: string };
            }>;
          } | undefined;

          const isFinalTranscript = (t: typeof inputTrans | typeof outputTrans): boolean => {
            if (!t || typeof t !== 'object') return false;
            const r = t as Record<string, unknown>;
            // If a partial flag is present, treat partial === false as final.
            if (typeof r['partial'] === 'boolean') {
              return (r['partial'] as boolean) === false;
            }
            // Otherwise, presence of a final_* field indicates final transcript.
            if (typeof r['final_transcript'] === 'string' || typeof r['finalTranscript'] === 'string') {
              return true;
            }
            return false;
          };

          const getTranscript = (t: typeof inputTrans | typeof outputTrans): string => {
            if (!t || typeof t !== 'object') return '';
            const r = t as Record<string, unknown>;
            const v = r['final_transcript'] ?? r['finalTranscript'] ?? r['transcript'] ?? r['text'];
            return typeof v === 'string' ? v : '';
          };

          const userText = isFinalTranscript(inputTrans) ? getTranscript(inputTrans) : '';
          if (userText) onUserTranscript?.(userText);

          const witnessText = isFinalTranscript(outputTrans) ? getTranscript(outputTrans) : '';
          if (witnessText) {
            setStatusSafe('witness_speaking');
            onWitnessTranscript?.(stripWitnessLabels(witnessText));
          }

          if (content?.parts) {
            for (const part of content.parts) {
              const inline = part.inline_data ?? part.inlineData;
              const raw = inline && typeof inline === 'object' && ((inline as Record<string, unknown>).data ?? (inline as Record<string, unknown>).bytes);
              const mime = inline && typeof inline === 'object' && ((inline as Record<string, unknown>).mimeType ?? (inline as Record<string, unknown>).mime_type);
              if (raw !== undefined && raw !== null && (typeof raw === 'string' || Array.isArray(raw))) {
                setStatusSafe('witness_speaking');
                onAudioChunk?.(raw, typeof mime === 'string' ? mime : undefined);
              }
              const partText = part.text;
              if (typeof partText === 'string' && partText.trim()) {
                setStatusSafe('witness_speaking');
                onWitnessTranscript?.(stripWitnessLabels(partText.trim()));
              }
            }
          }

          // Turn complete -> back to listening
          if (data.turn_complete === true || data.turnComplete === true) {
            onTurnComplete?.();
            setStatusSafe('listening');
          }
        } catch (e) {
          console.warn('useWitnessLive: parse error', e);
        }
      };

      ws.onerror = () => {
        setError('WebSocket error');
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (statusRef.current !== 'idle') setStatusSafe('idle');
      };
    },
    [onUserTranscript, onWitnessTranscript, onAudioChunk, onEvent, onInterrupted, onReady, onTurnComplete, startMicCapture, stopLive, setStatusSafe]
  );

  const sendText = useCallback((text: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'text', text }));
    }
  }, []);

  const sendAudio = useCallback((base64Pcm: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'audio', data: base64Pcm }));
    }
  }, []);

  return {
    connected,
    error,
    status,
    startLive,
    stopLive,
    sendText,
    sendAudio,
  };
}
