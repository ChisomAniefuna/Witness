/**
 * Hook for Witness Live WebSocket: connect to Python ADK Bidi service,
 * send init (persona + objectLabels), stream audio/text and receive events.
 * Mic capture: 16 kHz mono PCM, sent as binary WebSocket frames (matches bidi-demo reference).
 * See ADK Gemini Live API Toolkit guide: input 16-bit PCM 16kHz, 50–100ms chunks; output 24kHz.
 */
import { useCallback, useRef, useState } from 'react';

const SAMPLE_RATE_TARGET = 16000;
const SAMPLE_RATE_DEFAULT = 48000;
/** 50ms chunks — fast enough for ADK VAD to react within one buffer. */
const CHUNK_MS = 50;
const BARGE_IN_COOLDOWN_MS = 400;
/** Tuned for a quiet room; lower = more sensitive. Boost if you get false triggers. */
const BARGE_IN_BASE_RMS = 0.02;
const BARGE_IN_NOISE_MULT = 2.5;
const BARGE_IN_PEAK_MULT = 1.3;
/** 3 consecutive frames (~50ms each) of speech before we fire barge-in. */
const BARGE_IN_REQUIRED_FRAMES = 3;
/** Local barge-in: stop witness audio the moment the user speaks, before server acks.
 *  The echo-fade guard (ECHO_FADE_MS) prevents speaker echo from triggering this falsely. */
const ENABLE_LOCAL_BARGE_IN = true;

/** Downsample Float32Array (e.g. 48k) to 16k and convert to Int16 PCM. */
function toPcm16k(
  float32: Float32Array,
  sourceSampleRate: number
): ArrayBuffer {
  const ratio = sourceSampleRate / SAMPLE_RATE_TARGET;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s =
      idx + 1 < float32.length
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
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Parse sample rate from mime type e.g. "audio/pcm;rate=24000" -> 24000 */
function parsePcmRate(mimeType?: string): number {
  if (!mimeType) return 24000;
  const m = mimeType.match(/rate=(\d+)/i);
  return m ? parseInt(m[1]!, 10) : 24000;
}

function normalizeTranscriptText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSameTranscriptUtterance(
  previous: string,
  incoming: string
): boolean {
  const left = normalizeTranscriptText(previous);
  const right = normalizeTranscriptText(incoming);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftWords = left.split(' ');
  const rightWords = right.split(' ');
  const overlapThreshold = Math.max(
    3,
    Math.floor(Math.min(leftWords.length, rightWords.length) * 0.6)
  );

  let suffixPrefixOverlap = 0;
  const maxOverlap = Math.min(leftWords.length, rightWords.length);
  for (let index = maxOverlap; index > 0; index -= 1) {
    const leftSlice = leftWords.slice(-index).join(' ');
    const rightSlice = rightWords.slice(0, index).join(' ');
    if (leftSlice === rightSlice) {
      suffixPrefixOverlap = index;
      break;
    }
  }

  return suffixPrefixOverlap >= overlapThreshold;
}

function chooseFinalTranscript(previous: string, incoming: string): string {
  if (!previous) return incoming;
  if (!incoming) return previous;
  if (isSameTranscriptUtterance(previous, incoming)) {
    return incoming.length >= previous.length ? incoming : previous;
  }
  return incoming;
}

function containsDevanagari(text: string): boolean {
  return /[\u0900-\u097F]/.test(text);
}

const META_PHRASES = [
  "i'm taking on",
  "i've formulated",
  "i'm trying to address",
  "i'm now zeroing",
  'the goal is to',
  'it feels appropriately',
  'this is a delicate',
  "i'm keeping my persona",
  "i'm focusing on",
  'formulated a response',
  'taking on the role',
  "i've established the scenario",
  "i've developed the initial",
  'i settled on:',
  'crafting the initial',
  "i'm focused on the user",
  'my primary strategy',
  'question is still echoing',
  "i'm employing the",
  "i'm touching my glasses",
  'i am happy with the current outcome',
  "the detective's greeting requires",
  'the clipped delivery',
  "establishing finch's",
  'the greeting has been received',
  "i've responded as leo finch",
  'maintaining clipped evasion',
  'the character acknowledges',
  'i am keeping to the persona',
  "here's what i've got",
  'priority one',
  'adopting leo finch',
  'my response needs to be',
  "i'll highlight my work",
  "i'm analyzing",
  'i have to be evasive',
  'stick to my cover story',
  "i'm still dancing around",
  'i must keep deflecting',
  'i will try to display',
  "i'm focused on navigating",
  'my current strategy',
  'feigning discomfort',
  'body language such as',
  'clears throat',
  'touching my glasses',
  'enhance my performance',
  'steer the conversation',
];

/** Strip leading **Label**, stage directions *...*, meta sentences, and extract quoted dialogue. */
function stripWitnessLabels(text: string): string {
  let s = text.replace(/^\s*\*\*[^*]+\*\*\s*/g, '').trim();
  s = s.replace(/\s*\*[^*]*\*\s*/g, ' ').trim();
  const quoted =
    /(?:formulated a response|settled on|I settled on):\s*["\u201C]([^"\u201D]+)["\u201D]/i.exec(
      s
    ) ?? /response:\s*["\u201C]([^"\u201D]+)["\u201D]/i.exec(s);
  if (quoted?.[1]) s = quoted[1].trim();
  const sentences = s.split(/(?<=[.!?])\s+/).filter(sent => {
    const lower = sent.toLowerCase();
    return !META_PHRASES.some(p => lower.includes(p));
  });
  const cleaned = sentences.join(' ').replace(/\s+/g, ' ').trim();
  if (cleaned) return cleaned;
  const lower = s.toLowerCase();
  if (META_PHRASES.some(p => lower.includes(p))) return '';
  return s;
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

// Buffer before playing: keep enough audio queued to smooth network jitter without adding much lag.
const MIN_BUFFER_MS = 60;
const PLAYBACK_LOOKAHEAD_MS = 20;
const CHUNK_CROSSFADE_MS = 10;

/** Create a simple queue-based PCM player for witness audio (e.g. 24 kHz from Gemini). */
export function createLiveAudioPlayer(): {
  playChunk: (data: string | number[], mimeType?: string) => void;
  /** Flush buffered audio so the tail of a turn plays. */
  flush: () => void;
  /** Immediately stop playback and clear queue. */
  stop: () => void;
  /**
   * suppress() = stop() + drop all future chunks until release() is called.
   * Use on barge-in — old-turn audio from the server keeps arriving for ~200ms after the
   * interrupted event; without suppression those stale chunks would restart playback.
   */
  suppress: () => void;
  /** Re-enable playback for the next witness turn. Call on turn_complete. */
  release: () => void;
} {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let scheduledUntil = 0;
  const activeSources = new Set<AudioBufferSourceNode>();
  // When suppressed, playChunk silently drops new chunks until release() is called.
  let suppressed = false;
  const accumulator: {
    buffers: ArrayBuffer[];
    totalBytes: number;
    sampleRate: number;
  } = {
    buffers: [],
    totalBytes: 0,
    sampleRate: 24000,
  };

  function ensureContext(): AudioContext {
    if (!ctx) {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(1, ctx.currentTime);
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function scheduleBuffer(buffer: ArrayBuffer, sampleRate: number): void {
    if (!buffer || buffer.byteLength === 0) return;
    const audioContext = ensureContext();
    const int16 = new Int16Array(buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i]! / (int16[i]! < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = audioContext.createBuffer(
      1,
      float32.length,
      sampleRate
    );
    audioBuffer.getChannelData(0).set(float32);

    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    const lookaheadSeconds = PLAYBACK_LOOKAHEAD_MS / 1000;
    const duration = audioBuffer.duration;
    const crossfadeSeconds = Math.min(CHUNK_CROSSFADE_MS / 1000, duration / 3);
    const overlapStart =
      scheduledUntil > 0 ? Math.max(0, scheduledUntil - crossfadeSeconds) : 0;
    const startAt = Math.max(
      audioContext.currentTime + lookaheadSeconds,
      overlapStart
    );
    const endAt = startAt + duration;

    source.buffer = audioBuffer;
    source.connect(gainNode);
    gainNode.connect(masterGain!);

    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.linearRampToValueAtTime(1, startAt + crossfadeSeconds);
    gainNode.gain.setValueAtTime(
      1,
      Math.max(startAt + crossfadeSeconds, endAt - crossfadeSeconds)
    );
    gainNode.gain.linearRampToValueAtTime(0.0001, endAt);

    source.onended = () => {
      activeSources.delete(source);
    };

    activeSources.add(source);
    source.start(startAt);
    scheduledUntil = endAt;
  }

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
    scheduleBuffer(merged, rate);
  }

  function stopPlayback(): void {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch (_) {}
    }
    activeSources.clear();
    accumulator.buffers = [];
    accumulator.totalBytes = 0;
    scheduledUntil = 0;
    masterGain = null;
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
    if (suppressed) return;
    const buffer = decodeAudioData(data);
    if (!buffer || buffer.byteLength === 0) return;
    const sampleRate = parsePcmRate(mimeType);
    accumulator.buffers.push(buffer);
    accumulator.totalBytes += buffer.byteLength;
    accumulator.sampleRate = sampleRate;
    const minBytes = Math.floor(sampleRate * (MIN_BUFFER_MS / 1000) * 2);
    if (accumulator.totalBytes >= minBytes) flushAccumulator();
  }

  function suppress(): void {
    stopPlayback();
    suppressed = true;
  }

  function release(): void {
    suppressed = false;
  }

  return {
    playChunk,
    flush: flushAccumulator,
    stop: stopPlayback,
    suppress,
    release,
  };
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
  /** Called when a user transcript is received; isFinal=false means an interim update. */
  onUserTranscript?: (text: string, isFinal?: boolean) => void;
  /** Called when a witness transcript is received; isFinal=false means an interim update. */
  onWitnessTranscript?: (text: string, isFinal?: boolean) => void;
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
    const url = env.startsWith('ws')
      ? env
      : `ws://${env.replace(/^https?:\/\//, '')}`;
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
  const {
    onUserTranscript,
    onWitnessTranscript,
    onAudioChunk,
    onEvent,
    onInterrupted,
    onReady,
    onTurnComplete,
  } = options;
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'idle' | 'connecting' | 'listening' | 'witness_speaking'
  >('idle');
  const statusRef = useRef<
    'idle' | 'connecting' | 'listening' | 'witness_speaking'
  >('idle');
  const wsRef = useRef<WebSocket | null>(null);
  const initSentRef = useRef(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const enableMicRef = useRef(false);
  const sendAudioRef = useRef<(buf: ArrayBuffer) => void>(() => {});
  const lastLocalInterruptMsRef = useRef(0);
  const noiseFloorRef = useRef(0.01);
  const localBargeActiveFramesRef = useRef(0);
  const hasOutputTranscriptionInTurnRef = useRef(false);
  const userTranscriptClosedRef = useRef(false);
  const streamedTextRef = useRef<{ user: string; witness: string }>({
    user: '',
    witness: '',
  });
  // After witness finishes speaking, ignore mic for this many ms to let speaker echo fade
  // before resuming noise-floor adaptation. This prevents VAD false-triggers from echo.
  const echoFadeUntilRef = useRef(0);
  const ECHO_FADE_MS = 400;

  const resetStreamedText = useCallback((role?: 'user' | 'witness') => {
    if (!role) {
      streamedTextRef.current.user = '';
      streamedTextRef.current.witness = '';
      return;
    }
    streamedTextRef.current[role] = '';
  }, []);

  const mergeStreamedText = useCallback(
    (role: 'user' | 'witness', incoming: string): string => {
      const previous = streamedTextRef.current[role];
      if (!previous) {
        streamedTextRef.current[role] = incoming;
        return incoming;
      }
      if (incoming === previous) {
        return previous;
      }
      if (incoming.startsWith(previous)) {
        streamedTextRef.current[role] = incoming;
        return incoming;
      }
      if (isSameTranscriptUtterance(previous, incoming)) {
        const chosen = incoming.length >= previous.length ? incoming : previous;
        streamedTextRef.current[role] = chosen;
        return chosen;
      }
      if (
        previous.startsWith(incoming) ||
        previous.endsWith(incoming) ||
        incoming.includes(previous)
      ) {
        if (incoming.includes(previous) && incoming.length > previous.length) {
          streamedTextRef.current[role] = incoming;
          return incoming;
        }
        return previous;
      }

      let overlap = 0;
      const maxOverlap = Math.min(previous.length, incoming.length);
      for (let index = maxOverlap; index > 0; index -= 1) {
        if (previous.endsWith(incoming.slice(0, index))) {
          overlap = index;
          break;
        }
      }

      if (overlap > 0) {
        const merged = `${previous}${incoming.slice(overlap)}`;
        streamedTextRef.current[role] = merged;
        return merged;
      }

      const needsSpace =
        !/[\s([{\-"']$/.test(previous) && !/^[\s)\]}.!,?:;\-"']/.test(incoming);
      const merged = `${previous}${needsSpace ? ' ' : ''}${incoming}`;
      streamedTextRef.current[role] = merged;
      return merged;
    },
    []
  );

  const setStatusSafe = useCallback((next: typeof statusRef.current) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const stopLive = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    mediaStreamRef.current?.getTracks().forEach(t => t.stop());
    mediaStreamRef.current = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    initSentRef.current = false;
    noiseFloorRef.current = 0.01;
    lastLocalInterruptMsRef.current = 0;
    localBargeActiveFramesRef.current = 0;
    hasOutputTranscriptionInTurnRef.current = false;
    userTranscriptClosedRef.current = false;
    echoFadeUntilRef.current = 0;
    resetStreamedText();
    setConnected(false);
    setStatusSafe('idle');
    setError(null);
  }, [resetStreamedText, setStatusSafe]);

  const startMicCapture = useCallback(
    (sendAudioBinary: (pcmBuffer: ArrayBuffer) => void) => {
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: SAMPLE_RATE_TARGET,
          },
        })
        .then(stream => {
          mediaStreamRef.current = stream;
          // Use the browser's native sample rate; toPcm16k downsamples to 16kHz.
          const ctx = new AudioContext({ latencyHint: 'interactive' });
          audioContextRef.current = ctx;
          if (ctx.state === 'suspended') ctx.resume();
          const source = ctx.createMediaStreamSource(stream);
          // 4096-frame buffer gives stable 85ms callback intervals at 48kHz.
          const bufferSize = 4096;
          const processor = ctx.createScriptProcessor(bufferSize, 1, 1);
          processorRef.current = processor;
          let buffer: number[] = [];
          const sr = ctx.sampleRate;
          const samplesPerChunk = Math.floor(
            (SAMPLE_RATE_TARGET / 1000) * CHUNK_MS
          );
          // Number of source samples per output chunk
          const srcSamplesPerChunk = Math.floor(
            (sr / SAMPLE_RATE_TARGET) * samplesPerChunk
          );

          processor.onaudioprocess = e => {
            const input = e.inputBuffer.getChannelData(0);

            // Local barge-in amplitude tracking (even when ENABLE_LOCAL_BARGE_IN=false)
            let maxAbs = 0;
            let sumSq = 0;
            for (let i = 0; i < input.length; i++) {
              const v = Math.abs(input[i]!);
              if (v > maxAbs) maxAbs = v;
              sumSq += v * v;
            }
            const rms = input.length ? Math.sqrt(sumSq / input.length) : 0;
            const now = Date.now();
            // Freeze noise-floor adaptation during witness speech AND during the echo-fade
            // window that immediately follows turn_complete. This prevents echo tail from
            // inflating the noise floor and confusing the VAD.
            const inEchoFade = now < echoFadeUntilRef.current;
            if (statusRef.current !== 'witness_speaking' && !inEchoFade) {
              const next = noiseFloorRef.current * 0.9 + rms * 0.1;
              noiseFloorRef.current = Math.max(0.003, next);
            }
            const adaptive = Math.max(
              BARGE_IN_BASE_RMS,
              noiseFloorRef.current * BARGE_IN_NOISE_MULT
            );
            const aboveBargeThreshold =
              statusRef.current === 'witness_speaking' &&
              rms > adaptive &&
              maxAbs > adaptive * BARGE_IN_PEAK_MULT;

            if (aboveBargeThreshold) {
              localBargeActiveFramesRef.current += 1;
            } else {
              localBargeActiveFramesRef.current = 0;
            }

            if (
              ENABLE_LOCAL_BARGE_IN &&
              aboveBargeThreshold &&
              localBargeActiveFramesRef.current >= BARGE_IN_REQUIRED_FRAMES &&
              now - lastLocalInterruptMsRef.current > BARGE_IN_COOLDOWN_MS
            ) {
              lastLocalInterruptMsRef.current = now;
              localBargeActiveFramesRef.current = 0;
              onInterrupted?.();
              setStatusSafe('listening');
            }

            // Always accumulate mic samples into buffer.
            for (let i = 0; i < input.length; i++) buffer.push(input[i]!);

            // Flush complete chunks
            while (buffer.length >= srcSamplesPerChunk) {
              const chunk = new Float32Array(
                buffer.splice(0, srcSamplesPerChunk)
              );
              const pcm = toPcm16k(chunk, sr);
              sendAudioBinary(pcm);
            }
          };
          source.connect(processor);
          processor.connect(ctx.destination);
        })
        .catch(err => {
          console.error('useWitnessLive: mic error', err);
          setError(
            err instanceof Error
              ? err.message
              : 'Microphone access failed. Please check permissions and input device.'
          );
          setStatusSafe('idle');
          if (enableMicRef && 'current' in enableMicRef) {
            enableMicRef.current = false;
          }
        });
    },
    [onInterrupted, setStatusSafe]
  );

  const startLive = useCallback(
    (
      persona: WitnessPersonaForLive,
      objectLabels: string[],
      enableMic = false
    ) => {
      stopLive();
      enableMicRef.current = enableMic;
      setError(null);
      setStatusSafe('connecting');
      const wsUrl = getLiveWsUrl();
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      // Send raw PCM as binary frame — matches bidi-demo reference; no base64 overhead.
      sendAudioRef.current = (pcmBuffer: ArrayBuffer) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(pcmBuffer);
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

      ws.onmessage = event => {
        try {
          const data = JSON.parse(event.data as string) as Record<
            string,
            unknown
          >;
          const msgType = data.type as string | undefined;
          const isPartialEvent = data.partial === true;
          const eventAuthor =
            typeof data.author === 'string' ? data.author : undefined;
          onEvent?.(data);

          if (data.interrupted === true) {
            echoFadeUntilRef.current = Date.now() + ECHO_FADE_MS;
            hasOutputTranscriptionInTurnRef.current = false;
            userTranscriptClosedRef.current = false;
            resetStreamedText('witness');
            onInterrupted?.();
            setStatusSafe('listening');
          }

          if (msgType === 'connected' || msgType === 'init_ack') {
            setStatusSafe('listening');
            if (msgType === 'init_ack') {
              onReady?.();
              if (enableMicRef.current)
                startMicCapture(
                  sendAudioRef.current as (buf: ArrayBuffer) => void
                );
            }
            return;
          }
          if (msgType === 'error') {
            const message =
              typeof data.message === 'string' ? data.message : 'Unknown error';
            const detail = typeof data.detail === 'string' ? data.detail : '';
            setError(detail ? `${message}: ${detail}` : message);
            return;
          }

          // ADK Event: support both snake_case and camelCase (model_dump_json by_alias)
          const inputTrans = (data.input_transcription ??
            data.inputAudioTranscription ??
            data.inputTranscription) as
            | {
                final_transcript?: string;
                transcript?: string;
                text?: string;
                finalTranscript?: string;
                finished?: boolean;
                partial?: boolean;
              }
            | undefined;
          const outputTrans = (data.output_transcription ??
            data.outputAudioTranscription ??
            data.outputTranscription) as
            | {
                final_transcript?: string;
                transcript?: string;
                text?: string;
                finalTranscript?: string;
                finished?: boolean;
                partial?: boolean;
              }
            | undefined;
          const content = data.content as
            | {
                parts?: Array<{
                  text?: string;
                  thought?: boolean;
                  functionCall?: unknown;
                  function_call?: unknown;
                  functionResponse?: unknown;
                  function_response?: unknown;
                  inline_data?: { data?: string; mime_type?: string };
                  inlineData?: {
                    data?: string;
                    mimeType?: string;
                    mime_type?: string;
                  };
                }>;
              }
            | undefined;

          const isFinalTranscript = (
            t: typeof inputTrans | typeof outputTrans
          ): boolean => {
            if (!t || typeof t !== 'object') return false;
            const r = t as Record<string, unknown>;
            // If a partial flag is present, treat partial === false as final.
            if (typeof r['partial'] === 'boolean') {
              return (r['partial'] as boolean) === false;
            }
            if (typeof r['finished'] === 'boolean') {
              return r['finished'] as boolean;
            }
            // Otherwise, presence of a final_* field indicates final transcript.
            if (
              typeof r['final_transcript'] === 'string' ||
              typeof r['finalTranscript'] === 'string'
            ) {
              return true;
            }
            return false;
          };

          const getTranscript = (
            t: typeof inputTrans | typeof outputTrans
          ): string => {
            if (!t || typeof t !== 'object') return '';
            const r = t as Record<string, unknown>;
            const v =
              r['final_transcript'] ??
              r['finalTranscript'] ??
              r['transcript'] ??
              r['text'];
            return typeof v === 'string' ? v : '';
          };

          const userText = getTranscript(inputTrans);
          if (userText && !containsDevanagari(userText)) {
            if (userTranscriptClosedRef.current) {
              // Input and output transcriptions can arrive out of order. Once the witness
              // has started responding, ignore late user ASR finals to avoid duplicate bubbles.
            } else {
              const isFinal = isFinalTranscript(inputTrans);
              const streamedUserText = isFinal
                ? chooseFinalTranscript(streamedTextRef.current.user, userText)
                : mergeStreamedText('user', userText);
              streamedTextRef.current.user = streamedUserText;
              onUserTranscript?.(streamedUserText, isFinal);
              if (isFinal) {
                resetStreamedText('user');
                userTranscriptClosedRef.current = true;
              }
            }
          }

          const witnessText = getTranscript(outputTrans);
          if (witnessText) {
            hasOutputTranscriptionInTurnRef.current = true;
            userTranscriptClosedRef.current = true;
            setStatusSafe('witness_speaking');
            const isFinal = isFinalTranscript(outputTrans);
            const streamedWitnessText = isFinal
              ? chooseFinalTranscript(
                  streamedTextRef.current.witness,
                  witnessText
                )
              : mergeStreamedText('witness', witnessText);
            streamedTextRef.current.witness = streamedWitnessText;
            const cleaned = stripWitnessLabels(streamedWitnessText);
            if (cleaned) {
              onWitnessTranscript?.(cleaned, isFinal);
              if (isFinal) resetStreamedText('witness');
            }
          }

          const hasTranscriptText = Boolean(userText || witnessText);

          if (content?.parts) {
            const textParts = content.parts
              .filter(part => {
                if (!part || typeof part !== 'object') return false;
                if (part.thought) return false;
                if (part.functionCall || part.function_call) return false;
                if (part.functionResponse || part.function_response)
                  return false;
                return (
                  typeof part.text === 'string' && part.text.trim().length > 0
                );
              })
              .map(part => part.text!.trim());
            const textPayload = textParts.join(' ').trim();

            if (isPartialEvent && !hasTranscriptText && textPayload) {
              const role = eventAuthor === 'user' ? 'user' : 'witness';
              if (
                role === 'user' &&
                (userTranscriptClosedRef.current ||
                  containsDevanagari(textPayload))
              ) {
                // Ignore late or obviously wrong-language user partials.
              } else {
                const mergedText = mergeStreamedText(role, textPayload);

                if (role === 'user') {
                  onUserTranscript?.(mergedText, false);
                } else {
                  userTranscriptClosedRef.current = true;
                  setStatusSafe('witness_speaking');
                  const cleaned = stripWitnessLabels(mergedText);
                  if (cleaned) {
                    onWitnessTranscript?.(cleaned, false);
                  }
                }
              }
            }

            const shouldSkipTextContent =
              !isPartialEvent && hasOutputTranscriptionInTurnRef.current;

            for (const part of content.parts) {
              if (
                shouldSkipTextContent &&
                typeof part.text === 'string' &&
                part.text.trim()
              ) {
                continue;
              }
              const inline = part.inline_data ?? part.inlineData;
              const raw =
                inline &&
                typeof inline === 'object' &&
                ((inline as Record<string, unknown>).data ??
                  (inline as Record<string, unknown>).bytes);
              const mime =
                inline &&
                typeof inline === 'object' &&
                ((inline as Record<string, unknown>).mimeType ??
                  (inline as Record<string, unknown>).mime_type);
              if (
                raw !== undefined &&
                raw !== null &&
                (typeof raw === 'string' || Array.isArray(raw))
              ) {
                userTranscriptClosedRef.current = true;
                setStatusSafe('witness_speaking');
                onAudioChunk?.(
                  raw,
                  typeof mime === 'string' ? mime : undefined
                );
              }
            }
          }

          // Turn complete -> back to listening; set echo-fade window
          if (data.turn_complete === true || data.turnComplete === true) {
            echoFadeUntilRef.current = Date.now() + ECHO_FADE_MS;
            hasOutputTranscriptionInTurnRef.current = false;
            userTranscriptClosedRef.current = false;
            resetStreamedText();
            onTurnComplete?.();
            setStatusSafe('listening');
          }
        } catch (e) {
          console.warn('useWitnessLive: parse error', e);
        }
      };

      ws.onerror = () => {
        setError(prev => prev ?? 'WebSocket connection failed');
      };

      ws.onclose = () => {
        wsRef.current = null;
        setConnected(false);
        if (statusRef.current !== 'idle') setStatusSafe('idle');
      };
    },
    [
      onUserTranscript,
      onWitnessTranscript,
      onAudioChunk,
      onEvent,
      onInterrupted,
      onReady,
      onTurnComplete,
      startMicCapture,
      stopLive,
      resetStreamedText,
      mergeStreamedText,
      setStatusSafe,
    ]
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
