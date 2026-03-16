/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Camera,
  Eye,
  Mic,
  Scale,
  FileText,
  ChevronLeft,
  Sun,
  Moon,
  AlertCircle,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {
  analyzeScene,
  generateWitnessPersona,
  generateCaseFile,
  getInterrogationResponse,
  detectContradiction,
  checkSafety,
  getEngagementResponse,
  getAccusationOptions,
  evaluateAccusation,
  generateCaseFileTimeline,
  CaseFile,
  WitnessPersona,
} from './services/geminiService';
import { useWitnessLive, createLiveAudioPlayer } from './hooks/useWitnessLive';

type Screen =
  | 'splash'
  | 'onboarding'
  | 'camera'
  | 'witness'
  | 'interrogation'
  | 'accusation'
  | 'casefile'
  | 'verdict';

type InterrogationMode = 'text' | 'voice';

interface DetectionObject {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  flagged: boolean;
  description: string;
}

interface Message {
  role: 'witness' | 'user';
  text: string;
  isStreaming?: boolean;
  isContradiction?: boolean;
  contradictionQuote?: string;
  id?: string;
}

interface TestimonyReview {
  quote: string;
  status: 'CONTRADICTION' | 'UNVERIFIED' | 'VERIFIED' | 'CRITICAL';
}

interface AccusationOptions {
  suspects: string[];
  methods: string[];
  motives: string[];
}

interface Verdict {
  correct: boolean;
  verdict: string;
  explanation: string;
  oneTrueThing?: string;
  testimonyReview?: TestimonyReview[];
}

interface DetectiveProfile {
  displayName: string;
  totalScore: number;
  casesSolved: number;
  casesAttempted: number;
  badges: string[];
}

const STORAGE_KEY = 'witness_state_v1';
const DETECTIVE_PROFILE_KEY = 'witness_detective_profile_v1';
const CAMERA_PERMISSION_KEY = 'witness_camera_permission_v1';

const WITNESS_LOADING_RULES = [
  'Lead with one clear question.',
  'Lock the timeline first.',
  'Use the evidence by name.',
  'Recheck weak answers once.',
];

const WITNESS_RULE_SCROLL_MS = 7000;
const WITNESS_END_FADE_MS = 500;

interface PersistedStateV1 {
  version: 1;
  savedAt: number;
  currentScreen: Screen;
  interrogationMode?: InterrogationMode;
  detections: DetectionObject[];
  showProceed: boolean;
  persona: WitnessPersona | null;
  caseFile: CaseFile | null;
  messages: Message[];
  timeLeft: number;
  contradictionCount: number;
  lastMessageTime: number;
  witnessQuote: string | null;
  analysisError: boolean;
  accusationOptions: AccusationOptions | null;
  selectedSuspect: string | null;
  selectedMotive: string | null;
  selectedMethod: string | null;
  theory: string;
  verdict: Verdict | null;
  timeline: string[];
  caseSignature: string | null;
}

function normalizeMessageText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadPersistedState(): PersistedStateV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedStateV1;
    if (!parsed || parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistState(state: PersistedStateV1): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore write errors (private mode, quota, etc.)
  }
}

function loadDetectiveProfile(): DetectiveProfile | null {
  try {
    const raw = localStorage.getItem(DETECTIVE_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DetectiveProfile;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistDetectiveProfile(profile: DetectiveProfile): void {
  try {
    localStorage.setItem(DETECTIVE_PROFILE_KEY, JSON.stringify(profile));
  } catch {}
}

function getProfileRating(score: number): string {
  if (score > 500) return 'LEGENDARY';
  if (score > 200) return 'SENIOR';
  if (score > 50) return 'OFFICER';
  return 'ROOKIE';
}

function resolveInitialScreen(persisted: PersistedStateV1 | null): Screen {
  if (!persisted) return 'splash';
  const hasScan =
    Array.isArray(persisted.detections) && persisted.detections.length > 0;
  const hasPersona = !!persisted.persona;
  const hasInterrogation =
    hasPersona &&
    Array.isArray(persisted.messages) &&
    persisted.messages.length > 0;
  const hasAccusation = !!persisted.accusationOptions;
  const hasVerdict = !!persisted.verdict;
  const hasCaseFile = !!persisted.caseFile;

  switch (persisted.currentScreen) {
    case 'verdict':
      if (hasVerdict) return 'verdict';
      if (hasAccusation) return 'accusation';
      if (hasInterrogation) return 'interrogation';
      if (hasPersona) return 'witness';
      return hasCaseFile ? 'casefile' : hasScan ? 'camera' : 'splash';
    case 'casefile':
      if (hasCaseFile) return 'casefile';
      if (hasAccusation) return 'accusation';
      if (hasInterrogation) return 'interrogation';
      if (hasPersona) return 'witness';
      return hasScan ? 'camera' : 'splash';
    case 'accusation':
      if (hasAccusation) return 'accusation';
      if (hasInterrogation) return 'interrogation';
      if (hasPersona) return 'witness';
      return hasScan ? 'camera' : 'splash';
    case 'interrogation':
      if (hasInterrogation) return 'interrogation';
      if (hasPersona) return 'witness';
      return hasScan ? 'camera' : 'splash';
    case 'witness':
      if (hasPersona) return 'witness';
      return hasScan ? 'camera' : 'splash';
    case 'camera':
      return 'camera';
    case 'onboarding':
      return hasScan ? 'camera' : 'onboarding';
    case 'splash':
    default:
      return 'splash';
  }
}

// ── Atmospheric audio ─────────────────────────────────────────────────────────

const useAtmosphericAudio = (isActive: boolean, tensionLevel: number) => {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const droneRef = useRef<{
    osc1: OscillatorNode;
    osc2: OscillatorNode;
    osc3: OscillatorNode;
    gain: GainNode;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(() => {
    const saved = localStorage.getItem('audio_muted');
    return saved === 'true';
  });

  useEffect(() => {
    localStorage.setItem('audio_muted', String(isMuted));
  }, [isMuted]);

  useEffect(() => {
    if (isActive && !audioCtxRef.current) {
      audioCtxRef.current = new (
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      )();
    }

    if (isActive && audioCtxRef.current && !isMuted) {
      if (audioCtxRef.current.state === 'suspended') {
        audioCtxRef.current.resume();
      }

      if (!droneRef.current) {
        const ctx = audioCtxRef.current;
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const osc3 = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(400, ctx.currentTime);

        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(40, ctx.currentTime);

        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(40.5, ctx.currentTime);

        osc3.type = 'sawtooth';
        osc3.frequency.setValueAtTime(80, ctx.currentTime);
        const osc3Gain = ctx.createGain();
        osc3Gain.gain.setValueAtTime(0, ctx.currentTime);

        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0.04, ctx.currentTime + 2);

        osc1.connect(filter);
        osc2.connect(filter);
        osc3.connect(osc3Gain);
        osc3Gain.connect(filter);
        filter.connect(gain);
        gain.connect(ctx.destination);

        osc1.start();
        osc2.start();
        osc3.start();
        droneRef.current = { osc1, osc2, osc3, gain };
        (droneRef.current as unknown as Record<string, unknown>).osc3Gain =
          osc3Gain;
        (droneRef.current as unknown as Record<string, unknown>).filter =
          filter;
      }
    } else {
      if (droneRef.current) {
        const ctx = audioCtxRef.current;
        if (ctx) {
          droneRef.current.gain.gain.linearRampToValueAtTime(
            0,
            ctx.currentTime + 0.5
          );
          const d = droneRef.current;
          setTimeout(() => {
            d.osc1.stop();
            d.osc2.stop();
            d.osc3.stop();
          }, 500);
        }
        droneRef.current = null;
      }
    }

    return () => {
      if (droneRef.current) {
        droneRef.current.osc1.stop();
        droneRef.current.osc2.stop();
        droneRef.current.osc3.stop();
        droneRef.current = null;
      }
    };
  }, [isActive, isMuted]);

  useEffect(() => {
    if (droneRef.current && audioCtxRef.current && !isMuted) {
      const ctx = audioCtxRef.current;
      const targetGain = Math.min(0.04 + tensionLevel * 0.02, 0.12);
      droneRef.current.gain.gain.linearRampToValueAtTime(
        targetGain,
        ctx.currentTime + 1
      );

      const osc3Gain = (droneRef.current as unknown as Record<string, GainNode>)
        .osc3Gain;
      const filter = (
        droneRef.current as unknown as Record<string, BiquadFilterNode>
      ).filter;

      osc3Gain.gain.linearRampToValueAtTime(
        tensionLevel * 0.005,
        ctx.currentTime + 1
      );
      filter.frequency.linearRampToValueAtTime(
        400 + tensionLevel * 100,
        ctx.currentTime + 1
      );
      droneRef.current.osc1.frequency.linearRampToValueAtTime(
        40 + tensionLevel * 1,
        ctx.currentTime + 1
      );
      droneRef.current.osc2.frequency.linearRampToValueAtTime(
        40.5 + tensionLevel * 1.1,
        ctx.currentTime + 1
      );
    }
  }, [tensionLevel, isMuted]);

  const playTell = (type: 'gulp' | 'tick') => {
    if (!audioCtxRef.current || isMuted) return;
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') ctx.resume();

    if (type === 'tick') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      gain.gain.setValueAtTime(0.005, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.01);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
    } else if (type === 'gulp') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(160, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
    }
  };

  return { playTell, isMuted, setIsMuted };
};

export default function App() {
  const [persistedState] = useState<PersistedStateV1 | null>(() =>
    loadPersistedState()
  );
  const [currentScreen, setCurrentScreen] = useState<Screen>(() =>
    resolveInitialScreen(persistedState)
  );
  const [interrogationMode, setInterrogationMode] = useState<InterrogationMode>(
    () => persistedState?.interrogationMode ?? 'text'
  );
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved ? saved === 'dark' : true;
  });
  const [cameraStatus, setCameraStatus] = useState<
    'idle' | 'live' | 'denied' | 'unsupported'
  >('idle');
  const [cameraIssue, setCameraIssue] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [detections, setDetections] = useState<DetectionObject[]>(
    () => persistedState?.detections ?? []
  );
  const [showProceed, setShowProceed] = useState(
    () =>
      persistedState?.showProceed ??
      (persistedState?.detections?.length ?? 0) > 0
  );

  const [persona, setPersona] = useState<WitnessPersona | null>(
    () => persistedState?.persona ?? null
  );
  const [caseFile, setCaseFile] = useState<CaseFile | null>(
    () => persistedState?.caseFile ?? null
  );
  const [isGeneratingPersona, setIsGeneratingPersona] = useState(false);
  const [isWitnessRuleScrollDone, setIsWitnessRuleScrollDone] = useState(false);
  const [contradictionCount, setContradictionCount] = useState(
    () => persistedState?.contradictionCount ?? 0
  );
  const [caughtContradictions, setCaughtContradictions] = useState<
    { quote1: string; quote2: string }[]
  >([]);
  const [selectedContradiction, setSelectedContradiction] = useState<
    string | null
  >(null);

  const [messages, setMessages] = useState<Message[]>(
    () => persistedState?.messages ?? []
  );
  const [userInput, setUserInput] = useState('');
  const [timeLeft, setTimeLeft] = useState(() => {
    const base = persistedState?.timeLeft ?? 180;
    const elapsed = persistedState
      ? Math.floor((Date.now() - persistedState.savedAt) / 1000)
      : 0;
    return Math.max(0, base - elapsed);
  }); // 3 minutes
  const [isInterrogating, setIsInterrogating] = useState(false);
  const [witnessQuote, setWitnessQuote] = useState<string | null>(
    () => persistedState?.witnessQuote ?? null
  );
  const [analysisError, setAnalysisError] = useState(
    () => persistedState?.analysisError ?? false
  );
  const [lastMessageTime, setLastMessageTime] = useState(Date.now());
  const [shortMessageCount, setShortMessageCount] = useState(0);

  const [accusationOptions, setAccusationOptions] =
    useState<AccusationOptions | null>(
      () => persistedState?.accusationOptions ?? null
    );
  const [selectedSuspect, setSelectedSuspect] = useState<string | null>(
    () => persistedState?.selectedSuspect ?? null
  );
  const [selectedMotive, setSelectedMotive] = useState<string | null>(
    () => persistedState?.selectedMotive ?? null
  );
  const [selectedMethod, setSelectedMethod] = useState<string | null>(
    () => persistedState?.selectedMethod ?? null
  );
  const [theory, setTheory] = useState(() => persistedState?.theory ?? '');
  const [activeEvidence, setActiveEvidence] = useState<string | null>(null);
  const [caseSignature, setCaseSignature] = useState<string | null>(
    () => persistedState?.caseSignature ?? null
  );
  const [verdict, setVerdict] = useState<Verdict | null>(
    () => persistedState?.verdict ?? null
  );
  const [timeline, setTimeline] = useState<string[]>(
    () => persistedState?.timeline ?? []
  );
  const [isSafetyFlagged, setIsSafetyFlagged] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [detectiveName, setDetectiveName] = useState('');
  const [detectiveProfile, setDetectiveProfile] =
    useState<DetectiveProfile | null>(() => loadDetectiveProfile());
  const [typedOpeningStatement, setTypedOpeningStatement] = useState('');
  const [isWitnessTyping, setIsWitnessTyping] = useState(false);
  const [videoBox, setVideoBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const cameraFrameRef = useRef<HTMLDivElement>(null);
  const liveAudioPlayerRef = useRef(createLiveAudioPlayer());
  const liveKickoffPendingRef = useRef(false);
  const forceNewLiveMessageRef = useRef(false);
  const lastServerTranscriptAtRef = useRef(0);
  const lastLocalTranscriptRef = useRef<{ text: string; at: number }>({
    text: '',
    at: 0,
  });
  const currentScreenRef = useRef<Screen>(currentScreen);
  const witnessTypeAudioCtxRef = useRef<AudioContext | null>(null);
  const typedStatementForRef = useRef('');
  const pendingPersonaRef = useRef<WitnessPersona | null>(null);
  const isWitnessRuleScrollDoneRef = useRef(false);

  const AVATAR_STORAGE_URL_KEY = 'witness_avatar_url_v1';

  const hashString = (input: string) => {
    let hash = 2166136261;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  };

  const buildDeterministicAvatarUrl = (signature: string) => {
    const hash = hashString(signature);
    const gender = hash % 2 === 0 ? 'women' : 'men';
    const index = hash % 100;
    return `https://randomuser.me/api/portraits/${gender}/${index}.jpg`;
  };

  const getPersonaSignature = (persona: WitnessPersona) => {
    const name = persona.name?.trim() || 'unknown';
    const age = Number.isFinite(persona.age) ? String(persona.age) : 'na';
    const occupation = persona.occupation?.trim() || 'unknown';
    const archetype = persona.archetype?.trim() || 'unknown';
    const opening = persona.openingStatement?.trim() || 'unknown';
    return `${name}|${age}|${occupation}|${archetype}|${opening}`;
  };

  const buildCaseSignatureFromLabels = (labels: string[]) => {
    if (!labels.length) return 'no-evidence';
    return labels
      .map(l => l.trim().toLowerCase())
      .sort()
      .join('|');
  };

  const getEvidenceSignature = () => {
    if (caseSignature) return caseSignature;
    return buildCaseSignatureFromLabels(detections.map(d => d.label));
  };

  const getAvatarSignature = (persona: WitnessPersona) => {
    const evidenceSig = getEvidenceSignature();
    if (evidenceSig !== 'no-evidence') return `evidence:${evidenceSig}`;
    return `persona:${getPersonaSignature(persona)}`;
  };

  const readStoredAvatar = () => {
    try {
      const storedUrl = localStorage.getItem(AVATAR_STORAGE_URL_KEY);
      return storedUrl || null;
    } catch {
      return null;
    }
  };

  const storeAvatar = (url: string) => {
    try {
      localStorage.setItem(AVATAR_STORAGE_URL_KEY, url);
    } catch {}
  };

  const ensurePersonaAvatar = (nextPersona: WitnessPersona): WitnessPersona => {
    if (nextPersona.avatarUrl) {
      storeAvatar(nextPersona.avatarUrl);
      return nextPersona;
    }
    const stored = readStoredAvatar();
    if (stored) return { ...nextPersona, avatarUrl: stored };
    const signature = getAvatarSignature(nextPersona);
    const fresh = buildDeterministicAvatarUrl(signature);
    storeAvatar(fresh);
    return { ...nextPersona, avatarUrl: fresh };
  };

  const commitWitnessPersona = (nextPersona: WitnessPersona) => {
    const personaWithAvatar = ensurePersonaAvatar(nextPersona);
    setPersona(personaWithAvatar);
    setMessages([
      { role: 'witness', text: personaWithAvatar.openingStatement },
    ]);
    setLastMessageTime(Date.now());
    setIsGeneratingPersona(false);
    pendingPersonaRef.current = null;
  };

  const queueOrCommitWitnessPersona = (nextPersona: WitnessPersona) => {
    const personaWithAvatar = ensurePersonaAvatar(nextPersona);
    pendingPersonaRef.current = personaWithAvatar;
    if (isWitnessRuleScrollDoneRef.current) {
      commitWitnessPersona(personaWithAvatar);
    }
  };

  const readCameraPermission = () => {
    try {
      return localStorage.getItem(CAMERA_PERMISSION_KEY) === 'true';
    } catch {
      return false;
    }
  };

  const writeCameraPermission = (granted: boolean) => {
    try {
      localStorage.setItem(CAMERA_PERMISSION_KEY, String(granted));
    } catch {}
  };

  const formatCaseDate = (date: Date) =>
    date.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

  const formatCaseTime = (date: Date) =>
    date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });

  const buildFallbackCaseFile = (labels: string[]): CaseFile => {
    const now = new Date();
    const seedSource = labels.join('|') || 'casefile';
    const seed = hashString(seedSource);
    const caseNumber = String((seed % 9000) + 1000).padStart(4, '0');

    const firstNames = [
      'Avery',
      'Jordan',
      'Noah',
      'Maya',
      'Priya',
      'Luis',
      'Hana',
      'Omar',
      'Lea',
      'Gabriel',
    ];
    const lastNames = [
      'Singh',
      'Park',
      'Diaz',
      'Okoro',
      'Mori',
      'Ivanov',
      'Patel',
      'Khan',
      'Reed',
      'Alvarez',
    ];
    const occupations = [
      'Teacher',
      'Paramedic',
      'Accountant',
      'Security Guard',
      'Nurse',
      'Mechanic',
      'Archivist',
      'Courier',
      'Analyst',
      'Caretaker',
    ];

    const pick = <T,>(arr: T[], offset: number) =>
      arr[(seed + offset) % arr.length];
    const victimName = `${pick(firstNames, 3)} ${pick(lastNames, 5)}`;
    const witnessName = `${pick(firstNames, 7)} ${pick(lastNames, 9)}`;

    const l0 = labels[0]?.toLowerCase() || 'main object';
    const l1 = labels[1]?.toLowerCase() || l0;
    const l2 = labels[2]?.toLowerCase() || l0;

    return {
      caseNumber,
      date: formatCaseDate(now),
      time: formatCaseTime(now),
      incidentType: labels.length
        ? `Reported incident involving the ${l0}.`
        : 'Reported incident under investigation.',
      victim: {
        name: victimName,
        age: 24 + (seed % 32),
        occupation: pick(occupations, 11),
        discovery: `Found near the ${l0} with signs of a sudden disturbance.`,
        condition: 'Unresponsive',
      },
      sceneReport: `Responders documented a disturbance centered on the ${l0}. A ${l1} was found out of position relative to the rest of the room. The ${l2} suggests the event was hurried and unplanned. One detail involving the ${l0} still does not align with the rest of the scene.`,
      witnessOnScene: {
        name: witnessName,
        age: 21 + (seed % 28),
        occupation: pick(occupations, 17),
        reason: 'Reported hearing a loud impact and checked the room.',
        demeanor: 'Cooperative and calm. Asked to leave soon after.',
      },
      assignedDate: `${formatCaseDate(now)}, ${formatCaseTime(now)}`,
    };
  };

  const loadCaseFileForObjects = async (labels: string[]) => {
    if (!labels.length) return;
    try {
      const cf = await generateCaseFile(labels);
      if (cf && cf.caseNumber) {
        setCaseFile(cf);
        return;
      }
      setCaseFile(buildFallbackCaseFile(labels));
    } catch (err) {
      console.error('Case file error:', err);
      setCaseFile(buildFallbackCaseFile(labels));
    }
  };

  const upsertLiveTranscript = (
    role: 'user' | 'witness',
    text: string,
    isFinal = true
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setLastMessageTime(Date.now());
    setMessages(prev => {
      const last = prev.at(-1);
      let next = prev;
      const forceNewMessage = forceNewLiveMessageRef.current;
      const nextMessage: Message = {
        role,
        text: trimmed,
        isStreaming: !isFinal,
      };

      if (last?.role === role && last.isStreaming) {
        const lastText = last.text.trim();
        const normalizedLast = normalizeMessageText(lastText);
        const normalizedNext = normalizeMessageText(trimmed);
        if (normalizedLast === normalizedNext) {
          next = [
            ...prev.slice(0, -1),
            {
              ...last,
              text: trimmed.length >= lastText.length ? trimmed : lastText,
              isStreaming: !isFinal,
            },
          ];
        } else {
          next = [...prev.slice(0, -1), { ...last, ...nextMessage }];
        }
        if (isFinal) {
          forceNewLiveMessageRef.current = false;
        }
      } else if (forceNewMessage) {
        next = [...prev, nextMessage];
        forceNewLiveMessageRef.current = false;
      } else if (last?.role === role) {
        const lastText = last.text.trim();
        if (!last.isStreaming && !isFinal) {
          if (
            normalizeMessageText(trimmed) === normalizeMessageText(lastText) ||
            lastText.startsWith(trimmed) ||
            trimmed.startsWith(lastText)
          ) {
            return prev;
          }
        }
        if (normalizeMessageText(trimmed) === normalizeMessageText(lastText)) {
          return prev;
        }
        if (
          last.isStreaming ||
          trimmed.startsWith(lastText) ||
          lastText.startsWith(trimmed)
        ) {
          next = [...prev.slice(0, -1), { ...last, ...nextMessage }];
        } else {
          next = [...prev, nextMessage];
        }
      } else {
        next = [...prev, nextMessage];
      }

      if (role === 'witness' && isFinal) {
        const lastIdx = next.length - 1;
        detectContradiction(next).then(r => {
          if (!r.contradiction) return;
          setContradictionCount(c => c + 1);
          setMessages(m =>
            m.map((msg, i) =>
              i === lastIdx && msg.role === 'witness'
                ? { ...msg, isContradiction: true, contradictionQuote: r.quote }
                : msg
            )
          );
        });
      }

      return next;
    });
  };

  const handleLiveUserTranscript = (text: string, isFinal?: boolean) => {
    lastServerTranscriptAtRef.current = Date.now();
    upsertLiveTranscript('user', text, isFinal);
  };

  const {
    connected: liveConnected,
    error: liveError,
    status: liveStatus,
    startLive,
    stopLive,
    sendText: sendLiveText,
  } = useWitnessLive({
    onUserTranscript: handleLiveUserTranscript,
    onWitnessTranscript: (text, isFinal) => {
      // In some sessions turn_complete can be delayed/missed after interruption.
      // Release on first non-final witness transcript so new audio is not stuck muted.
      if (isFinal === false) {
        liveAudioPlayerRef.current?.release();
      }
      upsertLiveTranscript('witness', text, isFinal);
    },
    onAudioChunk: (base64, mimeType) =>
      liveAudioPlayerRef.current?.playChunk(base64, mimeType),
    onInterrupted: () => {
      // suppress() stops current audio AND drops stale old-turn chunks still arriving from server
      liveAudioPlayerRef.current?.suppress();
      forceNewLiveMessageRef.current = true;
    },
    onTurnComplete: () => {
      // release() re-enables the player for the next turn, then flush the buffered tail
      liveAudioPlayerRef.current?.release();
      liveAudioPlayerRef.current?.flush();
      forceNewLiveMessageRef.current = true;
    },
    onReady: () => {
      if (currentScreenRef.current !== 'interrogation') {
        liveKickoffPendingRef.current = false;
        liveAudioPlayerRef.current?.stop();
        stopLive();
        setIsInterrogating(false);
        return;
      }
      if (!liveKickoffPendingRef.current) return;
      liveKickoffPendingRef.current = false;
      // Send kickoff immediately so the witness starts speaking with minimal wait.
      window.setTimeout(() => sendLiveText('Begin interrogation.'), 100);
    },
  });

  useEffect(() => {
    if (interrogationMode !== 'voice' || !liveConnected) return;
    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    const recognition: any = new SpeechRecognition();
    let stopped = false;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    const startIfListening = () => {
      if (stopped || liveStatus !== 'listening') return;
      try {
        recognition.start();
      } catch (_) {
        // ignore double-start errors
      }
    };

    recognition.onresult = (event: any) => {
      const now = Date.now();
      if (now - lastServerTranscriptAtRef.current < 1200) return;
      let interim = '';
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const res = event.results[i];
        const transcript = res?.[0]?.transcript ?? '';
        if (res?.isFinal) finalText += transcript;
        else interim += transcript;
      }
      const text = (finalText || interim).trim();
      if (!text) return;
      const normalized = normalizeMessageText(text);
      const last = lastLocalTranscriptRef.current;
      if (
        normalized &&
        normalized === normalizeMessageText(last.text) &&
        now - last.at < 1500
      ) {
        return;
      }
      lastLocalTranscriptRef.current = { text, at: now };
      upsertLiveTranscript('user', text, Boolean(finalText));
    };

    recognition.onend = () => {
      if (!stopped) startIfListening();
    };

    startIfListening();

    return () => {
      stopped = true;
      try {
        recognition.stop();
      } catch (_) {}
    };
  }, [interrogationMode, liveConnected, liveStatus]);

  const stopVoiceInterrogation = () => {
    liveKickoffPendingRef.current = false;
    liveAudioPlayerRef.current?.stop();
    stopLive();
    setIsInterrogating(false);
  };

  const navigateToScreen = (nextScreen: Screen) => {
    if (nextScreen !== 'interrogation') {
      stopVoiceInterrogation();
    }
    currentScreenRef.current = nextScreen;
    setCurrentScreen(nextScreen);
  };

  const toggleTheme = () => {
    setIsDark(prev => !prev);
  };

  const { playTell, isMuted, setIsMuted } = useAtmosphericAudio(
    currentScreen === 'interrogation',
    contradictionCount
  );

  useEffect(() => {
    if (currentScreen === 'interrogation') {
      const interval = setInterval(() => playTell('tick'), 8000);
      return () => clearInterval(interval);
    }
  }, [currentScreen, isMuted]);

  useEffect(() => {
    currentScreenRef.current = currentScreen;
    if (currentScreen !== 'interrogation') {
      stopVoiceInterrogation();
    }
  }, [currentScreen]);

  useEffect(() => {
    if (!liveError) return;
    const normalized = liveError.toLowerCase();
    const isModelAvailabilityIssue =
      normalized.includes('publisher model') ||
      (normalized.includes('model') &&
        (normalized.includes('not found') ||
          normalized.includes('not supported for bidigeneratecontent') ||
          normalized.includes('operation is not implemented')));

    if (!isModelAvailabilityIssue) return;
    if (interrogationMode !== 'voice') return;

    // Graceful degrade when Live model is unavailable for the project/key.
    stopVoiceInterrogation();
    setInterrogationMode('text');
    setMessages(prev => {
      const notice =
        'Voice mode is currently unavailable for this project configuration. Switched to text interrogation so you can continue the case.';
      const alreadyAdded = prev.some(
        m => m.role === 'witness' && m.text === notice
      );
      if (alreadyAdded) return prev;
      return [...prev, { role: 'witness', text: notice }];
    });
  }, [liveError, interrogationMode]);

  const beginInterrogation = () => {
    if (!persona) return;

    currentScreenRef.current = 'interrogation';
    setCurrentScreen('interrogation');

    if (interrogationMode === 'voice') {
      liveKickoffPendingRef.current = true;
      forceNewLiveMessageRef.current = true;
      startLive(
        {
          name: persona.name,
          archetype: persona.archetype,
          age: persona.age,
          occupation: persona.occupation,
          tells: persona.tells,
          openingStatement: persona.openingStatement,
          guiltyOf: persona.guiltyOf,
          secret: persona.secret,
        },
        detections.map(d => d.label),
        true
      );
    }
  };

  useEffect(() => {
    if (!persona?.openingStatement) {
      setTypedOpeningStatement('');
      setIsWitnessTyping(false);
      typedStatementForRef.current = '';
      return;
    }

    if (persona && !persona.avatarUrl) {
      setPersona(ensurePersonaAvatar(persona));
    }

    if (currentScreen !== 'witness') {
      setTypedOpeningStatement(persona.openingStatement);
      setIsWitnessTyping(false);
      return;
    }

    const fullText = persona.openingStatement;
    if (typedStatementForRef.current === fullText) {
      setTypedOpeningStatement(fullText);
      setIsWitnessTyping(false);
      return;
    }

    setTypedOpeningStatement('');
    setIsWitnessTyping(true);

    let lastTickTime = 0;

    const playTypeTick = (ch: string) => {
      if (!witnessTypeAudioCtxRef.current) {
        witnessTypeAudioCtxRef.current = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext
        )();
      }

      const ctx = witnessTypeAudioCtxRef.current;
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }

      const keySeed = ch.charCodeAt(0) || 65;
      const now = ctx.currentTime;

      // Avoid overlapping bursts that cause a buzzing/errrr texture.
      if (now - lastTickTime < 0.055) return;
      lastTickTime = now;

      const createNoiseBurst = (
        startTime: number,
        duration: number,
        centerFreq: number,
        q: number,
        peakGain: number
      ) => {
        const frameCount = Math.max(1, Math.floor(ctx.sampleRate * duration));
        const noiseBuffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
        const data = noiseBuffer.getChannelData(0);

        for (let i = 0; i < frameCount; i += 1) {
          const decay = 1 - i / frameCount;
          data[i] = (Math.random() * 2 - 1) * decay;
        }

        const source = ctx.createBufferSource();
        source.buffer = noiseBuffer;

        const bandpass = ctx.createBiquadFilter();
        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(centerFreq, startTime);
        bandpass.Q.setValueAtTime(q, startTime);

        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.setValueAtTime(650, startTime);

        const gain = ctx.createGain();
        gain.gain.setValueAtTime(peakGain, startTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

        source.connect(bandpass);
        bandpass.connect(highpass);
        highpass.connect(gain);
        gain.connect(ctx.destination);

        source.start(startTime);
        source.stop(startTime + duration);
      };

      // Professional keypress profile: clear key-down and subtle key-up.
      createNoiseBurst(now, 0.012, 1800 + (keySeed % 6) * 120, 1.9, 0.05);
      createNoiseBurst(
        now + 0.018,
        0.008,
        2500 + (keySeed % 4) * 110,
        2.4,
        0.02
      );
    };

    let index = 0;
    const interval = window.setInterval(() => {
      index += 1;
      const nextChar = fullText[index - 1] ?? '';
      setTypedOpeningStatement(fullText.slice(0, index));

      if (nextChar.trim()) {
        playTypeTick(nextChar);
      }

      if (index >= fullText.length) {
        window.clearInterval(interval);
        typedStatementForRef.current = fullText;
        setIsWitnessTyping(false);
      }
    }, 42);

    return () => {
      window.clearInterval(interval);
    };
  }, [currentScreen, persona?.openingStatement]);

  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [isDark]);

  useEffect(() => {
    const trimmedName = detectiveName.trim();
    if (!trimmedName) return;
    setDetectiveProfile(prev => {
      if (prev) {
        if (prev.displayName === trimmedName) return prev;
        const updated = { ...prev, displayName: trimmedName };
        persistDetectiveProfile(updated);
        return updated;
      }
      const fresh: DetectiveProfile = {
        displayName: trimmedName,
        totalScore: 0,
        casesSolved: 0,
        casesAttempted: 0,
        badges: [],
      };
      persistDetectiveProfile(fresh);
      return fresh;
    });
  }, [detectiveName]);

  useEffect(() => {
    if (detectiveProfile) {
      persistDetectiveProfile(detectiveProfile);
    }
  }, [detectiveProfile]);

  useEffect(() => {
    if (!caseSignature && detections.length) {
      setCaseSignature(
        buildCaseSignatureFromLabels(detections.map(d => d.label))
      );
    }
  }, [caseSignature, detections]);

  useEffect(() => {
    persistState({
      version: 1,
      savedAt: Date.now(),
      currentScreen,
      interrogationMode,
      detections,
      showProceed,
      persona,
      caseFile,
      messages,
      timeLeft,
      contradictionCount,
      lastMessageTime,
      witnessQuote,
      analysisError,
      accusationOptions,
      selectedSuspect,
      selectedMotive,
      selectedMethod,
      theory,
      verdict,
      timeline,
      caseSignature,
    });
  }, [
    currentScreen,
    interrogationMode,
    detections,
    showProceed,
    persona,
    caseFile,
    messages,
    timeLeft,
    contradictionCount,
    lastMessageTime,
    witnessQuote,
    analysisError,
    accusationOptions,
    selectedSuspect,
    selectedMotive,
    selectedMethod,
    theory,
    verdict,
    timeline,
    caseSignature,
  ]);

  const startCamera = async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      setCameraStatus('unsupported');
      setCameraIssue(
        'Camera is not supported in this browser. Try Chrome, Safari, or Edge on a mobile device.'
      );
      return;
    }

    if (
      typeof window !== 'undefined' &&
      !window.isSecureContext &&
      window.location.hostname !== 'localhost' &&
      window.location.hostname !== '127.0.0.1'
    ) {
      setCameraStatus('unsupported');
      setCameraIssue(
        'Camera access requires HTTPS. Open the app using a secure https:// URL.'
      );
      return;
    }

    setCameraIssue(null);

    const attempts: MediaStreamConstraints[] = [
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      {
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      { video: true, audio: false },
    ];

    let lastError: unknown = null;
    try {
      for (const constraints of attempts) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            streamRef.current = stream;
            setCameraStatus('live');
            writeCameraPermission(true);
            window.setTimeout(() => updateVideoBox(), 50);
            try {
              await videoRef.current.play();
            } catch {
              // Ignore autoplay rejections. Video still starts on user interaction.
            }
          }
          return;
        } catch (err) {
          lastError = err;
        }
      }

      throw lastError;
    } catch (err) {
      console.error('Camera error:', err);
      const name =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name?: string }).name)
          : '';

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setCameraStatus('denied');
        setCameraIssue(
          'Permission was blocked. Allow camera access in browser settings and tap Try Again.'
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setCameraStatus('denied');
        setCameraIssue(
          'No compatible camera was found. Try another browser or switch to a device with a camera.'
        );
      } else if (name === 'NotReadableError' || name === 'AbortError') {
        setCameraStatus('denied');
        setCameraIssue(
          'Camera is busy in another app. Close other camera apps and try again.'
        );
      } else {
        setCameraStatus('denied');
        setCameraIssue('Could not start camera. Please retry.');
      }

      writeCameraPermission(false);
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraStatus('idle');
  };

  const updateVideoBox = () => {
    if (!cameraFrameRef.current || !videoRef.current) return;
    const rect = cameraFrameRef.current.getBoundingClientRect();
    const videoWidth = videoRef.current.videoWidth || 1280;
    const videoHeight = videoRef.current.videoHeight || 720;
    if (!rect.width || !rect.height) return;

    const containerRatio = rect.width / rect.height;
    const videoRatio = videoWidth / videoHeight;
    let width = rect.width;
    let height = rect.height;

    if (videoRatio > containerRatio) {
      width = rect.width;
      height = rect.width / videoRatio;
    } else {
      height = rect.height;
      width = rect.height * videoRatio;
    }

    const x = (rect.width - width) / 2;
    const y = (rect.height - height) / 2;
    setVideoBox({ x, y, width, height });
  };

  useEffect(() => {
    let cancelled = false;

    const prepareCamera = async () => {
      if (currentScreen !== 'camera') {
        stopCamera();
        return;
      }

      const storedGranted = readCameraPermission();
      const canQuery =
        typeof navigator !== 'undefined' &&
        'permissions' in navigator &&
        typeof navigator.permissions.query === 'function';

      if (canQuery) {
        try {
          const status = await navigator.permissions.query({
            name: 'camera' as PermissionName,
          });
          if (cancelled) return;
          if (status.state === 'granted') {
            startCamera();
            return;
          }
          if (status.state === 'denied') {
            setCameraStatus('denied');
            return;
          }
        } catch {
          // Fall through to stored permission check.
        }
      }

      if (storedGranted) {
        startCamera();
        return;
      }

      setCameraStatus('idle');
    };

    prepareCamera();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [currentScreen]);

  useEffect(() => {
    if (currentScreen !== 'camera') return;
    const onResize = () => updateVideoBox();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [currentScreen]);

  useEffect(() => {
    if (currentScreen === 'interrogation' && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft(prev => prev - 1);

        // Engagement Monitor: Fire if no message in 30 seconds
        if (
          Date.now() - lastMessageTime > 30000 &&
          !isInterrogating &&
          persona
        ) {
          setLastMessageTime(Date.now());
          handleEngagement();
        }
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [currentScreen, timeLeft, lastMessageTime, isInterrogating, persona]);

  const handleEngagement = async () => {
    if (!persona) return;
    setIsInterrogating(true);
    try {
      const response = await getEngagementResponse(persona);
      setMessages(prev => [...prev, { role: 'witness', text: response }]);
    } catch (err) {
      console.error('Engagement error:', err);
    } finally {
      setIsInterrogating(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const captureScene = async () => {
    if (!videoRef.current || isScanning) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0);
    }

    const imageData = canvas.toDataURL('image/jpeg', 0.8);

    setIsScanning(true);
    setShowProceed(false);
    setDetections([]);
    setTheory('');
    setCaseFile(null);
    setAnalysisError(false);
    setWitnessQuote(null);

    try {
      const result = await analyzeScene(imageData);
      setDetections(result.objects);
      setCaseSignature(
        buildCaseSignatureFromLabels(result.objects.map(obj => obj.label))
      );
      setWitnessQuote(result.witnessReaction);
      loadCaseFileForObjects(result.objects.map(obj => obj.label));

      setIsScanning(false);
      setShowProceed(true);
    } catch (err) {
      console.error('Analysis error:', err);
      setAnalysisError(true);

      // Fallback to mock data
      const mockDetections = [
        {
          label: 'Blood Splatter',
          x: 45,
          y: 30,
          w: 15,
          h: 15,
          flagged: true,
          description: 'A dark, viscous stain that tells a story of violence.',
        },
        {
          label: 'Discarded Glove',
          x: 20,
          y: 70,
          w: 10,
          h: 10,
          flagged: true,
          description: 'Latex, torn at the thumb. Someone was in a hurry.',
        },
        {
          label: 'Broken Glass',
          x: 65,
          y: 55,
          w: 12,
          h: 12,
          flagged: false,
          description:
            'A shattered tumbler. The last drink was never finished.',
        },
      ];
      setDetections(mockDetections);
      setCaseSignature(
        buildCaseSignatureFromLabels(mockDetections.map(obj => obj.label))
      );
      const fallbackQuote =
        "I... I shouldn't have come back here. The air feels heavy with what happened.";
      setWitnessQuote(fallbackQuote);
      loadCaseFileForObjects(mockDetections.map(obj => obj.label));

      setIsScanning(false);
      setShowProceed(true);
    }
  };

  const handleMeetWitness = async () => {
    setIsGeneratingPersona(true);
    isWitnessRuleScrollDoneRef.current = false;
    setIsWitnessRuleScrollDone(false);
    setPersona(null);
    setMessages([]);
    typedStatementForRef.current = '';
    pendingPersonaRef.current = null;
    setCurrentScreen('witness');
    try {
      const p = await generateWitnessPersona(detections.map(d => d.label));
      queueOrCommitWitnessPersona(p);
    } catch (err) {
      console.error('Persona generation error:', err);
      // Fallback persona
      const fallback: WitnessPersona = {
        name: 'FRANCIS',
        archetype: 'The Nervous Wreck',
        age: 42,
        occupation: 'Night Watchman',
        tells: ['Twitching eye', 'Wringing hands'],
        openingStatement:
          '"I was here when it happened. I heard everything. I saw him leave. At least… I think that\'s what I saw."',
        guiltyOf: 'Accidental Manslaughter',
        secret: 'He was sleeping on the job when the crime occurred.',
        method:
          'killed the person with knife he brought,then threw him from the balcony to make it seem like an accident',
        crimeSceneNarrative:
          'I was on duty when I heard a crash. I went in, saw the room in disarray, and left before anyone noticed.',
        objectConnections: [],
      };
      queueOrCommitWitnessPersona(fallback);
    } finally {
      // Loading exits only after both generation is done and rule-scroll is complete.
    }
  };

  useEffect(() => {
    if (!(currentScreen === 'witness' && isGeneratingPersona)) return;
    const timer = window.setTimeout(() => {
      setIsWitnessRuleScrollDone(true);
    }, WITNESS_RULE_SCROLL_MS);
    return () => window.clearTimeout(timer);
  }, [currentScreen, isGeneratingPersona]);

  useEffect(() => {
    if (currentScreen === 'witness') return;
    if (isGeneratingPersona) {
      setIsGeneratingPersona(false);
      pendingPersonaRef.current = null;
    }
  }, [currentScreen, isGeneratingPersona]);

  useEffect(() => {
    isWitnessRuleScrollDoneRef.current = isWitnessRuleScrollDone;
    if (!isWitnessRuleScrollDone) return;
    if (!pendingPersonaRef.current) return;
    commitWitnessPersona(pendingPersonaRef.current);
  }, [isWitnessRuleScrollDone]);

  const typeOutWitnessResponse = (
    text: string,
    meta?: {
      isContradiction?: boolean;
      contradictionQuote?: string;
      onComplete?: () => void;
    }
  ) => {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `w_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const total = text.length;
    const step = Math.max(1, Math.ceil(total / 120));
    let index = 0;

    setMessages(prev => [
      ...prev,
      { id, role: 'witness', text: '', isStreaming: true },
    ]);

    const interval = window.setInterval(() => {
      index = Math.min(total, index + step);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === id
            ? { ...msg, text: text.slice(0, index), isStreaming: index < total }
            : msg
        )
      );

      if (index >= total) {
        window.clearInterval(interval);
        if (meta?.isContradiction) {
          setContradictionCount(c => c + 1);
        }
        if (meta?.isContradiction || meta?.contradictionQuote) {
          setMessages(prev =>
            prev.map(msg =>
              msg.id === id
                ? {
                    ...msg,
                    isContradiction: meta?.isContradiction,
                    contradictionQuote: meta?.contradictionQuote,
                  }
                : msg
            )
          );
        }
        meta?.onComplete?.();
      }
    }, 18);
  };

  const sendLiveUserText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (liveStatus === 'witness_speaking') {
      liveAudioPlayerRef.current?.stop();
    }
    upsertLiveTranscript('user', trimmed, true);
    sendLiveText(trimmed);
  };

  const sendMessage = async () => {
    if (!userInput.trim() || isInterrogating || !persona) return;

    const text = userInput.trim();
    setUserInput('');
    setLastMessageTime(Date.now());

    // Show the user's message immediately so taps always produce visible feedback.
    const userMsg: Message = { role: 'user', text };
    const newMessages: Message[] = [...messages, userMsg];
    setMessages(newMessages);
    setIsInterrogating(true);

    // Engagement Monitor: Track short messages
    if (text.split(' ').length < 6) {
      setShortMessageCount(prev => prev + 1);
    } else {
      setShortMessageCount(0);
    }

    try {
      // 1. SAFETY MONITOR
      // Do not block the entire send flow if safety service is temporarily unavailable.
      try {
        const safety = await checkSafety(text);
        if (!safety.safe) {
          setIsSafetyFlagged(true);
          setMessages(prev => [
            ...prev,
            {
              role: 'witness',
              text: "Let's focus on the case... I don't want to talk about that.",
            },
          ]);
          setIsInterrogating(false);
          return;
        }
      } catch (safetyErr) {
        console.warn('Safety check unavailable, continuing:', safetyErr);
      }

      // Engagement Monitor: Fire if 3 consecutive short messages
      if (shortMessageCount >= 2) {
        setShortMessageCount(0);
        const engagementResponse = await getEngagementResponse(persona);
        typeOutWitnessResponse(engagementResponse, {
          onComplete: () => setIsInterrogating(false),
        });
        return;
      }

      // 2. PERSONA GUARD (Implicitly handled by getInterrogationResponse with persona details)
      // 3. INTERROGATION RESPONSE
      let response = await getInterrogationResponse(
        newMessages,
        persona,
        detections.map(d => d.label)
      );

      // 4. CONTRADICTION DETECTOR
      const contradictionCheck = await detectContradiction([
        ...newMessages,
        { role: 'witness', text: response },
      ]);
      typeOutWitnessResponse(response, {
        isContradiction: contradictionCheck.contradiction,
        contradictionQuote: contradictionCheck.quote,
        onComplete: () => setIsInterrogating(false),
      });
    } catch (err) {
      console.error('Interrogation error:', err);
      typeOutWitnessResponse("I... I can't remember. My head is spinning.", {
        onComplete: () => setIsInterrogating(false),
      });
    } finally {
      // handled by typeOutWitnessResponse
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const applyVerdictToProfile = (isCorrect: boolean) => {
    setDetectiveProfile(prev => {
      const baseProfile: DetectiveProfile = prev ?? {
        displayName: detectiveName.trim() || 'DETECTIVE',
        totalScore: 0,
        casesSolved: 0,
        casesAttempted: 0,
        badges: [],
      };

      const baseScore = isCorrect ? 120 : 40;
      const contradictionBonus = contradictionCount * 15;
      const timeBonus = Math.min(60, Math.floor(timeLeft / 10));
      const caseScore = baseScore + contradictionBonus + timeBonus;

      const casesSolved = baseProfile.casesSolved + (isCorrect ? 1 : 0);
      const casesAttempted = baseProfile.casesAttempted + 1;
      const totalScore = baseProfile.totalScore + caseScore;

      const badges = [...baseProfile.badges];
      if (!badges.includes('first_case')) {
        badges.push('first_case');
      }
      if (caseScore >= 100 && !badges.includes('sharp_eye')) {
        badges.push('sharp_eye');
      }
      if (casesSolved >= 5 && !badges.includes('veteran')) {
        badges.push('veteran');
      }

      const updated = {
        ...baseProfile,
        totalScore,
        casesSolved,
        casesAttempted,
        badges,
      };

      persistDetectiveProfile(updated);
      return updated;
    });
  };

  const handleAccuse = async () => {
    if (!persona) return;
    navigateToScreen('accusation');
    try {
      const options = await getAccusationOptions(
        detections.map(d => d.label),
        persona
      );
      // Ensure the witness's true motive is in the options
      if (!options.motives.includes(persona.guiltyOf)) {
        options.motives[0] = persona.guiltyOf;
      }
      setAccusationOptions(options);
    } catch (err) {
      console.error('Accusation options error:', err);
    }
  };

  const handleSubmitVerdict = async () => {
    if (
      !selectedSuspect ||
      !selectedMotive ||
      !selectedMethod ||
      !persona ||
      !theory.trim()
    )
      return;
    setIsEvaluating(true);
    const startedAt = Date.now();
    let success = false;
    try {
      const res = await evaluateAccusation(
        {
          suspect: selectedSuspect,
          method: selectedMethod,
          motive: selectedMotive,
          theory: theory.trim(),
        },
        {
          witness: persona.name,
          objects: detections.map(d => d.label),
          guiltyOf: persona.guiltyOf,
          method: persona.method,
        }
      );
      setVerdict(res);
      applyVerdictToProfile(res.correct);

      try {
        const t = await generateCaseFileTimeline(
          persona,
          detections.map(d => d.label)
        );
        setTimeline(t);
      } catch (timelineErr) {
        console.error('Timeline generation error:', timelineErr);
        // Keep the flow moving even if timeline generation fails.
        setTimeline([
          'Initial disturbance reported at the scene.',
          `${persona.name} was identified as a key witness.`,
          'Contradictions were detected during interrogation.',
          'Final verdict submitted by the detective.',
        ]);
      }
      success = true;
    } catch (err) {
      console.error('Verdict error:', err);
    } finally {
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, 1200 - elapsed);
      window.setTimeout(() => {
        setIsEvaluating(false);
        if (success) {
          navigateToScreen('verdict');
        }
      }, wait);
    }
  };

  const hasScan = detections.length > 0;
  const hasPersona = !!persona;
  const hasInterrogation = !!persona && messages.length > 0;
  const hasAccusation = !!accusationOptions;
  const hasCaseFile = !!caseFile;
  const hasVerdict = !!verdict;
  const isCaseFileActive =
    currentScreen === 'casefile' || currentScreen === 'verdict';
  const testimonyReview = (() => {
    const witnessMessages = messages.filter(
      msg => msg.role === 'witness' && !msg.isStreaming
    );
    if (!witnessMessages.length) return [];
    const flaggedLabels = detections
      .filter(obj => obj.flagged)
      .map(obj => obj.label.toLowerCase());
    return witnessMessages.slice(-3).map(msg => {
      const rawQuote = msg.contradictionQuote || msg.text;
      const cleanedQuote =
        rawQuote.replace(/^\"+|\"+$/g, '').trim() || rawQuote;
      const lowered = cleanedQuote.toLowerCase();
      const isCritical = flaggedLabels.some(
        label => label && lowered.includes(label)
      );
      const status = msg.isContradiction
        ? 'CONTRADICTION'
        : isCritical
          ? 'CRITICAL'
          : 'VERIFIED';
      return { quote: cleanedQuote, status };
    });
  })();

  return (
    <div
      className={`w-full h-full flex flex-col ${isDark ? 'bg-bg text-ink' : 'bg-bg text-ink'}`}
    >
      <AnimatePresence mode="wait">
        {isEvaluating && (
          <motion.div
            key="evaluating"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg"
          >
            <div className="relative">
              <div className="w-24 h-24 border-2 border-red-noir/20 rounded-full animate-ping" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Scale className="w-8 h-8 text-red-noir animate-pulse" />
              </div>
            </div>
            <div className="mt-12 text-center">
              <div className="font-mono text-[10px] tracking-[6px] text-red-noir uppercase mb-2">
                Analyzing Theory
              </div>
              <div className="font-serif text-sm text-ink4 italic">
                Consulting official records...
              </div>
            </div>
          </motion.div>
        )}
        {currentScreen === 'splash' && (
          <motion.div
            key="splash"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg overflow-hidden"
          >
            {/* Background Texture & Vignette */}
            <div className="absolute inset-0 z-0 opacity-[0.03] pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/pinstripe.png')]" />
            <div className="absolute inset-0 z-0 bg-radial from-transparent via-transparent to-black/20 pointer-events-none" />

            {/* Massive Background Typography */}
            <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none select-none overflow-hidden">
              <motion.h1
                initial={{ scale: 1.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 0.03 }}
                transition={{ duration: 1.5, ease: 'easeOut' }}
                className="font-display text-[50vw] text-ink leading-none tracking-tighter rotate-[-12deg] translate-y-[-10%]"
              >
                NOIR
              </motion.h1>
            </div>

            {/* Top Bar Labels */}
            <div className="absolute top-0 left-0 w-full p-8 flex justify-between items-start z-30">
              <div className="flex flex-col gap-1">
                <div className="font-mono text-[8px] tracking-[4px] text-red-noir uppercase">
                  Project // Witness
                </div>
                <div className="font-mono text-[7px] tracking-[2px] text-ink4 uppercase opacity-50">
                  v2.5.0_PROD
                </div>
              </div>
              <div className="flex items-center gap-6">
                <button
                  onClick={() => setIsMuted(!isMuted)}
                  className="text-ink4 hover:text-red-noir transition-colors"
                  aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                >
                  {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                </button>
                <button
                  onClick={toggleTheme}
                  className="text-ink4 hover:text-red-noir transition-colors"
                  aria-label={
                    isDark ? 'Switch to light theme' : 'Switch to dark theme'
                  }
                >
                  {isDark ? <Sun size={16} /> : <Moon size={16} />}
                </button>
              </div>
            </div>

            {/* Main Content */}
            <div className="relative z-20 flex flex-col items-center text-center max-w-lg px-8">
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="w-16 h-16 rounded-full border border-red-noir/20 flex items-center justify-center mb-12 relative"
              >
                <div className="w-2.5 h-2.5 rounded-full bg-red-noir animate-pulse shadow-[0_0_15px_rgba(155,35,24,0.5)]" />
                <div className="absolute inset-[-12px] rounded-full border border-red-noir/5 animate-ping [animation-duration:5s]" />
              </motion.div>

              <motion.div
                initial={{ y: 40, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{
                  delay: 0.4,
                  duration: 1,
                  ease: [0.16, 1, 0.3, 1],
                }}
              >
                <h1 className="font-display text-[clamp(80px,20vw,160px)] text-ink tracking-tighter leading-[0.75] mb-12 uppercase">
                  WITNESS
                </h1>
                <div className="flex items-center gap-4 justify-center mb-12">
                  <div className="h-px w-12 bg-red-noir/30" />
                  <div className="font-mono text-[9px] tracking-[6px] text-red-noir uppercase">
                    Case File #882
                  </div>
                  <div className="h-px w-12 bg-red-noir/30" />
                </div>
                <p className="font-serif text-[clamp(20px,5.5vw,26px)] italic font-light text-ink2 leading-relaxed mb-20 max-w-sm mx-auto text-center">
                  "The room remembers what the eyes forget. Point your lens at
                  the truth."
                </p>
              </motion.div>

              <div className="w-full max-w-xs space-y-8">
                <motion.button
                  initial={{ y: 20, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: 0.8 }}
                  onClick={() => setCurrentScreen('onboarding')}
                  className="group relative w-full font-display text-xs tracking-[8px] text-white uppercase bg-red-noir py-8 shadow-[0_30px_60px_rgba(155,35,24,0.25)] hover:shadow-[0_40px_80px_rgba(155,35,24,0.35)] active:scale-95 transition-all overflow-hidden"
                >
                  <span className="relative z-10">ENTER THE SCENE</span>
                  <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                </motion.button>
              </div>
            </div>

            {/* Corner Accents */}
            <div className="absolute top-12 left-12 w-20 h-px bg-red-noir/10" />
            <div className="absolute top-12 left-12 w-px h-20 bg-red-noir/10" />
            <div className="absolute bottom-12 right-12 w-20 h-px bg-red-noir/10" />
            <div className="absolute bottom-12 right-12 w-px h-20 bg-red-noir/10" />
          </motion.div>
        )}

        {currentScreen === 'onboarding' && (
          <motion.div
            key="onboarding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col bg-bg overflow-y-auto"
          >
            {/* Header with Back Button */}
            <div className="absolute top-0 left-0 w-full p-6 z-20 flex justify-between items-center">
              <button
                onClick={() => navigateToScreen('splash')}
                className="flex items-center gap-2 font-mono text-[10px] tracking-[3px] text-ink4 hover:text-red-noir transition-colors group"
              >
                <ChevronLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                BACK
              </button>
              <div className="font-mono text-[8px] tracking-[4px] text-ink4/30 uppercase">
                Section 01 // Induction
              </div>
            </div>

            <div className="flex-1 flex flex-col min-h-full pb-32">
              <div className="relative flex-1 min-h-[400px] flex items-center justify-center overflow-hidden bg-bg2">
                {/* Atmospheric Glow */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[80vw] h-[80vw] max-w-[600px] max-h-[600px] rounded-full bg-radial from-red-noir/5 to-transparent blur-3xl" />

                <motion.svg
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 1.5, ease: 'easeOut' }}
                  className="w-[clamp(300px,90vw,500px)] h-auto block relative z-10 drop-shadow-[0_0_30px_rgba(0,0,0,0.5)]"
                  viewBox="0 0 360 320"
                >
                  <defs>
                    <radialGradient id="doorGlow" cx="50%" cy="40%" r="60%">
                      <stop
                        offset="0%"
                        stopColor="#f59e0b"
                        stopOpacity="0.25"
                      />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
                    </radialGradient>
                    <linearGradient id="doorSpill" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.4" />
                      <stop
                        offset="100%"
                        stopColor="#f59e0b"
                        stopOpacity="0.02"
                      />
                    </linearGradient>
                    <filter id="noise">
                      <feTurbulence
                        type="fractalNoise"
                        baseFrequency="0.8"
                        numOctaves="4"
                        stitchTiles="stitch"
                      />
                      <feColorMatrix type="saturate" values="0" />
                    </filter>
                  </defs>

                  {/* Floor */}
                  <rect x="0" y="285" width="360" height="35" fill="#050505" />
                  <line
                    x1="0"
                    y1="285"
                    x2="360"
                    y2="285"
                    stroke="#1a1a1a"
                    strokeWidth="0.5"
                  />

                  {/* Light Spill on Floor */}
                  <ellipse
                    cx="180"
                    cy="285"
                    rx="120"
                    ry="30"
                    fill="url(#doorGlow)"
                    opacity="0.5"
                  />

                  {/* Door Frame */}
                  <rect
                    x="100"
                    y="30"
                    width="160"
                    height="255"
                    fill="#000"
                    stroke="#1a1a1a"
                    strokeWidth="1"
                  />

                  {/* Interior Light */}
                  <rect
                    x="105"
                    y="35"
                    width="150"
                    height="250"
                    fill="#080808"
                  />
                  <rect
                    x="145"
                    y="35"
                    width="110"
                    height="250"
                    fill="url(#doorSpill)"
                  />

                  {/* The Detective Silhouette */}
                  <g className="detective">
                    {/* Fedora */}
                    <path d="M165 88 L195 88 L198 94 L162 94 Z" fill="#000" />
                    <path
                      d="M172 78 Q180 74 188 78 L190 88 L170 88 Z"
                      fill="#000"
                    />

                    {/* Head */}
                    <circle cx="180" cy="102" r="9" fill="#000" />

                    {/* Trench Coat */}
                    <path
                      d="M158 120 Q180 112 202 120 L215 285 L145 285 Z"
                      fill="#000"
                    />

                    {/* Arms */}
                    <path
                      d="M158 120 L145 200 L155 205 L165 125 Z"
                      fill="#000"
                    />
                    <path
                      d="M202 120 L215 200 L205 205 L195 125 Z"
                      fill="#000"
                    />

                    {/* Shadow */}
                    <ellipse
                      cx="180"
                      cy="285"
                      rx="45"
                      ry="6"
                      fill="#000"
                      opacity="0.8"
                    />
                  </g>

                  {/* Dust Motes (Animated in CSS/Framer) */}
                  <circle
                    cx="140"
                    cy="120"
                    r="0.6"
                    fill="#f59e0b"
                    opacity="0.3"
                  />
                  <circle
                    cx="220"
                    cy="160"
                    r="0.4"
                    fill="#f59e0b"
                    opacity="0.5"
                  />
                  <circle
                    cx="170"
                    cy="200"
                    r="0.8"
                    fill="#f59e0b"
                    opacity="0.2"
                  />
                </motion.svg>
              </div>

              <div className="relative z-10 bg-bg border-t border-border px-8 pt-12 pb-16 max-w-2xl mx-auto w-full">
                <div className="flex items-center gap-4 mb-8">
                  <div className="h-px flex-1 bg-border/50" />
                  <div className="h-px flex-1 bg-border/50" />
                </div>

                <div className="text-center mb-12">
                  <h2 className="font-display text-[clamp(28px,8vw,42px)] text-ink leading-[0.9] mb-6 uppercase tracking-tight">
                    Someone was here.
                    <br />
                    <span className="text-red-noir italic">
                      Now they're not.
                    </span>
                  </h2>
                  <p className="font-serif text-[clamp(16px,4.5vw,18px)] font-light text-ink2 leading-relaxed italic max-w-md mx-auto">
                    "The room remembers what the eyes forget. Point your lens at
                    the truth and find what they're hiding."
                  </p>
                </div>

                <div className="space-y-10">
                  <div className="group">
                    <div className="flex items-center gap-4 border-b border-border pb-3 group-focus-within:border-red-noir transition-colors">
                      <div className="font-mono text-[10px] tracking-[2px] text-ink4 uppercase whitespace-nowrap">
                        Detective ID:
                      </div>
                      <input
                        type="text"
                        value={detectiveName}
                        onChange={e => setDetectiveName(e.target.value)}
                        placeholder="ENTER NAME"
                        className="flex-1 bg-transparent border-none font-mono text-sm tracking-[3px] text-ink placeholder:text-ink4/20 focus:outline-none uppercase"
                        maxLength={32}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-6">
                    <div className="flex gap-3">
                      <div className="w-8 h-1 bg-red-noir" />
                      <div className="w-2 h-1 bg-border" />
                      <div className="w-2 h-1 bg-border" />
                    </div>

                    <button
                      onClick={() => {
                        if (detectiveName.trim()) {
                          navigateToScreen('camera');
                        }
                      }}
                      disabled={!detectiveName.trim()}
                      className={`group relative w-full font-display text-xs tracking-[6px] text-white uppercase py-6 shadow-[0_20px_40px_rgba(155,35,24,0.2)] active:scale-95 transition-all overflow-hidden ${!detectiveName.trim() ? 'bg-ink4 cursor-not-allowed opacity-50' : 'bg-red-noir cursor-pointer hover:shadow-[0_25px_50px_rgba(155,35,24,0.3)]'}`}
                    >
                      <span className="relative z-10">TAKE THE CASE</span>
                      <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentScreen === 'witness' && !persona && isGeneratingPersona && (
          <motion.div
            key="witness-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 bg-bg"
          >
            <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_20%_30%,rgba(155,35,24,0.16),transparent_45%),radial-gradient(circle_at_80%_70%,rgba(155,35,24,0.1),transparent_42%)]" />
            <div className="relative z-10 h-full grid grid-cols-1 md:grid-cols-2">
              <div className="hidden md:flex flex-col justify-end border-r border-border/40 px-10 pb-14 pt-20">
                <div className="font-mono text-[10px] tracking-[6px] text-red-noir uppercase mb-4 animate-flicker">
                  Witness Intake
                </div>
                <h2 className="font-display text-[clamp(48px,7.6vw,96px)] leading-[0.88] tracking-[0.16em] text-ink uppercase">
                  Mission
                  <br />
                  Briefing
                </h2>
                <p className="mt-5 max-w-[24ch] font-serif text-[clamp(16px,1.7vw,22px)] italic leading-relaxed text-ink3">
                  Interrogate smart. Pressure slowly. Break the story, not the
                  witness.
                </p>
                <div className="mt-8 font-mono text-[9px] tracking-[4px] text-ink4 uppercase">
                  Syncing witness memory core...
                </div>
              </div>

              <div className="relative flex flex-col justify-center px-6 md:px-12 py-16 overflow-hidden">
                <div className="absolute top-8 right-8 w-16 h-16 rounded-full border border-red-noir/30 flex items-center justify-center">
                  <div className="w-3 h-3 rounded-full bg-red-noir animate-pulse" />
                </div>

                <motion.div
                  initial={{ y: '42%' }}
                  animate={{ y: '-92%' }}
                  transition={{
                    duration: WITNESS_RULE_SCROLL_MS / 1000,
                    ease: 'linear',
                  }}
                  className="space-y-8"
                >
                  {WITNESS_LOADING_RULES.map((rule, index) => (
                    <div key={rule} className="max-w-xl">
                      <div className="font-mono text-[12px] tracking-[6px] text-red-noir/70 mb-2">
                        {String(index + 1).padStart(2, '0')}
                      </div>
                      <p className="font-serif text-[clamp(26px,4.8vw,54px)] leading-[1.04] text-ink">
                        {rule}
                      </p>
                      <div className="mt-5 h-px w-full bg-linear-to-r from-red-noir/35 via-border/40 to-transparent" />
                    </div>
                  ))}

                  <div className="pt-6">
                    <div className="font-mono text-[12px] tracking-[6px] text-red-noir/70 mb-2">
                      05
                    </div>
                    <p className="font-display text-[clamp(30px,5.4vw,58px)] leading-[0.95] tracking-[0.12em] uppercase text-red-noir/85">
                      Enter the interrogation chamber.
                    </p>
                  </div>
                </motion.div>

                <div className="absolute bottom-8 left-6 right-6 md:left-12 md:right-12 font-mono text-[9px] tracking-[4px] text-ink4 uppercase flex items-center justify-between">
                  <span>Preparing witness profile...</span>
                  <span>Stage 2 / 2</span>
                </div>
                <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-linear-to-b from-bg via-bg/75 to-transparent" />
                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-bg via-bg/75 to-transparent" />
              </div>
            </div>

            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 font-mono text-[9px] tracking-[5px] text-ink4 uppercase">
              Locating witness profile...
            </div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: WITNESS_END_FADE_MS / 1000,
                delay: Math.max(
                  0,
                  (WITNESS_RULE_SCROLL_MS - WITNESS_END_FADE_MS) / 1000
                ),
                ease: 'easeInOut',
              }}
              className="pointer-events-none absolute inset-0 z-40 bg-black"
            />
          </motion.div>
        )}

        {currentScreen === 'witness' && persona && (
          <motion.div
            key="witness"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 bg-bg overflow-y-auto"
          >
            <div className="min-h-full">
              {/* Header Section - Editorial Style */}
              <div className="relative h-[clamp(240px,45vh,380px)] bg-bg2 border-b border-border overflow-hidden">
                {/* Background Accents */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute top-0 left-0 w-full h-full bg-radial-[circle_at_20%_30%] from-red-noir/10 to-transparent" />
                  <div className="absolute -right-20 -top-20 w-64 h-64 rounded-full border border-red-noir/5" />
                </div>

                {/* Confidential Stamp */}
                <div className="absolute top-8 right-8 pointer-events-none">
                  <div className="border-2 border-red-noir/40 px-3 py-1.5 rotate-12 flex flex-col items-center">
                    <div className="font-display text-[10px] tracking-[4px] text-red-noir/60 uppercase leading-none mb-0.5">
                      CONFIDENTIAL
                    </div>
                    <div className="font-mono text-[7px] tracking-[2px] text-red-noir/40 uppercase">
                      EYES ONLY
                    </div>
                  </div>
                </div>

                {/* Main Header Content */}
                <div className="absolute inset-0 flex flex-col justify-end p-6 sm:p-8 pl-6 sm:pl-10 lg:pl-16">
                  <div className="flex items-end gap-6 mb-4">
                    <div className="relative group">
                      <div className="w-[clamp(100px,25vw,130px)] h-[clamp(100px,25vw,130px)] bg-bg border border-border p-1.5 shadow-2xl relative z-10">
                        <div className="w-full h-full overflow-hidden relative">
                          {persona.avatarUrl ? (
                            <img
                              src={persona.avatarUrl}
                              alt={persona.name}
                              className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-700"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-4xl bg-bg2">
                              🕵️
                            </div>
                          )}
                          <div className="absolute inset-0 border border-white/10 pointer-events-none" />
                        </div>
                      </div>
                      {/* Decorative Shadow/Offset */}
                      <div className="absolute -bottom-2 -right-2 w-full h-full border border-red-noir/20 -z-0" />
                    </div>

                    <div className="flex-1 pb-2">
                      <div className="font-mono text-[9px] tracking-[4px] text-red-noir uppercase mb-2">
                        {persona.archetype}
                      </div>
                      <div className="font-mono text-[10px] tracking-[4px] text-ink4 uppercase mb-2">
                        SUBJECT IDENTIFIED
                      </div>
                      <h2 className="font-display text-[clamp(24px,8vw,52px)] font-normal text-ink tracking-tight leading-[0.9] uppercase break-words hyphens-auto">
                        {persona.name}
                      </h2>
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-bg">
                <div className="max-w-6xl mx-auto px-6 sm:px-8 lg:px-12 py-10 pb-48 space-y-12">
                  {/* Opening Statement */}
                  <section>
                    <div className="flex items-center gap-4 mb-6">
                      <div className="h-px flex-1 bg-border" />
                      <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase">
                        Initial Contact
                      </div>
                      <div className="h-px w-8 bg-border" />
                    </div>
                    <p className="font-serif text-[clamp(18px,5vw,22px)] font-light italic text-ink leading-relaxed text-center px-4">
                      "{typedOpeningStatement}"
                      {isWitnessTyping && (
                        <span className="inline-block ml-1 w-[0.55ch] h-[1em] align-[-0.1em] bg-red-noir/60 animate-pulse" />
                      )}
                    </p>
                  </section>

                  {/* Narrative & Details Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
                    <div className="md:col-span-2 space-y-10">
                      <section>
                        <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-noir" />
                          Crime Scene Narrative
                        </div>
                        <div className="bg-bg2 p-6 border-l-2 border-red-noir/30">
                          <p className="font-serif text-[15px] text-ink2 leading-relaxed italic">
                            "
                            {persona.crimeSceneNarrative ||
                              witnessQuote ||
                              persona.openingStatement}
                            "
                          </p>
                        </div>
                      </section>

                      {/* Evidence Links */}
                      <section>
                        <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-6 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-noir" />
                          Evidence Connections
                        </div>
                        {persona.objectConnections &&
                        persona.objectConnections.length > 0 ? (
                          <div className="grid grid-cols-1 gap-4">
                            {persona.objectConnections.map((conn, i) => (
                              <div
                                key={`${conn.object}-${i}`}
                                className="group flex items-start gap-4 p-4 bg-bg border border-border hover:border-red-noir/30 transition-colors"
                              >
                                <div className="w-8 h-8 rounded-full bg-bg2 border border-border flex items-center justify-center font-mono text-[10px] text-ink4 group-hover:text-red-noir transition-colors">
                                  0{i + 1}
                                </div>
                                <div className="flex-1">
                                  <span className="font-display text-[11px] text-ink tracking-[2px] uppercase block mb-1">
                                    {conn.object}
                                  </span>
                                  <p className="font-serif text-[13px] text-ink3 leading-snug">
                                    {conn.significance}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : detections.length === 0 ? (
                          <div className="border border-border bg-bg2 p-4 text-sm text-ink3 italic">
                            No evidence logged yet. Return to the scene and scan
                            the room.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 gap-4">
                            {detections.map((obj, i) => {
                              const isActive = activeEvidence === obj.label;
                              return (
                                <button
                                  key={`${obj.label}-${i}`}
                                  onClick={() => setActiveEvidence(obj.label)}
                                  className={`group text-left flex items-start gap-4 p-4 border transition-colors ${
                                    isActive
                                      ? 'border-red-noir bg-red-noir/10'
                                      : 'border-border bg-bg hover:border-red-noir/30'
                                  }`}
                                >
                                  <div className="w-8 h-8 rounded-full bg-bg2 border border-border flex items-center justify-center font-mono text-[10px] text-ink4 group-hover:text-red-noir transition-colors">
                                    0{i + 1}
                                  </div>
                                  <div className="flex-1">
                                    <span className="font-display text-[11px] text-ink tracking-[2px] uppercase block mb-1">
                                      {obj.label}
                                    </span>
                                    <p className="font-serif text-[13px] text-ink3 leading-snug">
                                      {obj.description}
                                    </p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    </div>

                    {/* Sidebar Stats */}
                    <aside className="space-y-8">
                      <div className="border border-border divide-y divide-border bg-bg2">
                        <div className="p-5">
                          <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">
                            Age
                          </div>
                          <div className="font-serif text-lg text-ink">
                            {persona.age}
                          </div>
                        </div>
                        <div className="p-5">
                          <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">
                            Occupation
                          </div>
                          <div className="font-serif text-lg text-ink leading-tight">
                            {persona.occupation}
                          </div>
                        </div>
                        <div className="p-5">
                          <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">
                            Nervous Tells
                          </div>
                          <div className="space-y-2 mt-2">
                            {persona.tells.map((tell, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <div className="w-1 h-1 rounded-full bg-red-noir/40" />
                                <span className="font-serif text-sm text-ink2">
                                  {tell}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                          onClick={() => setInterrogationMode('text')}
                          className={`font-mono text-[9px] tracking-[2px] uppercase border px-3 py-3 transition-all ${
                            interrogationMode === 'text'
                              ? 'border-red-noir bg-red-noir/10 text-red-noir'
                              : 'border-border text-ink3 hover:border-red-noir/50'
                          }`}
                        >
                          Interrogate With Text
                        </button>
                        <button
                          onClick={() => setInterrogationMode('voice')}
                          className={`font-mono text-[9px] tracking-[2px] uppercase border px-3 py-3 transition-all ${
                            interrogationMode === 'voice'
                              ? 'border-red-noir bg-red-noir/10 text-red-noir'
                              : 'border-border text-ink3 hover:border-red-noir/50'
                          }`}
                        >
                          Interrogate With Voice
                        </button>
                      </div>

                      <AnimatePresence>
                        {!isWitnessTyping &&
                          typedOpeningStatement.length > 0 && (
                            <motion.button
                              initial={{ opacity: 0, y: 12, scale: 0.985 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: 8 }}
                              transition={{ duration: 0.35, ease: 'easeOut' }}
                              onClick={beginInterrogation}
                              className="group relative w-full font-display text-[10px] tracking-[5px] text-white uppercase bg-red-noir py-6 shadow-xl active:scale-95 transition-all overflow-hidden"
                            >
                              <span className="relative z-10">
                                {interrogationMode === 'voice'
                                  ? 'BEGIN VOICE INTERROGATION'
                                  : 'BEGIN TEXT INTERROGATION'}
                              </span>
                              <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                            </motion.button>
                          )}
                      </AnimatePresence>
                    </aside>
                  </div>

                  {/* Footer Spacer */}
                  <div className="h-12" />
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentScreen === 'interrogation' && persona && (
          <motion.div
            key="interrogation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg"
          >
            <div className="bg-surface border-b border-border px-6 py-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full border border-redmute flex items-center justify-center text-sm">
                  🕵️
                </div>
                <div>
                  <div className="font-mono text-[8px] tracking-[2px] text-red-noir uppercase">
                    {persona.archetype}
                  </div>
                  <div className="font-display text-sm tracking-widest text-ink">
                    {persona.name}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <div className="font-mono text-[7px] tracking-[2px] text-ink4 uppercase">
                    Contradictions
                  </div>
                  <div className="font-display text-xs text-red-noir">
                    {contradictionCount}
                  </div>
                </div>
                <button
                  onClick={() => setIsMuted(m => !m)}
                  className="text-ink3 hover:text-ink transition-colors"
                  aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
                >
                  {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                <div
                  className={`font-mono text-xs tracking-[2px] ${timeLeft < 30 ? 'text-red-noir animate-pulse' : 'text-ink2'}`}
                >
                  {formatTime(timeLeft)}
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
              {messages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`max-w-[85%] ${msg.role === 'user' ? 'self-end' : 'self-start'}`}
                >
                  <div
                    onClick={() =>
                      msg.isContradiction &&
                      setSelectedContradiction(msg.contradictionQuote || null)
                    }
                    className={`p-4 cursor-pointer transition-all ${
                      msg.role === 'user'
                        ? msg.isStreaming
                          ? 'bg-red-noir/5 border border-dashed border-red-noir/30 opacity-80'
                          : 'bg-red-noir/10 border border-red-noir/30'
                        : msg.isContradiction
                          ? 'bg-amber-noir/10 border border-amber-noir shadow-[0_0_15px_rgba(224,168,32,0.2)]'
                          : msg.isStreaming
                            ? 'bg-surface border border-dashed border-border opacity-80'
                            : 'bg-surface border border-border'
                    }`}
                  >
                    <p
                      className={`font-serif text-[15px] leading-relaxed ${msg.role === 'user' ? 'text-ink' : 'text-ink2'} ${msg.isStreaming ? 'italic' : ''}`}
                    >
                      {msg.text}
                      {msg.isStreaming && (
                        <span className="inline-block ml-1 w-[0.45ch] h-[0.9em] align-[-0.05em] bg-ink3/50 animate-pulse" />
                      )}
                    </p>
                    {msg.isContradiction && (
                      <div className="mt-2 font-mono text-[8px] text-amber-noir uppercase tracking-widest flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Contradiction
                        Detected
                      </div>
                    )}
                  </div>
                  <div
                    className={`mt-1 font-mono text-[7px] tracking-widest uppercase ${msg.isStreaming ? 'opacity-30' : 'opacity-40'} ${msg.role === 'user' ? 'text-right' : 'text-left'}`}
                  >
                    {msg.role === 'user'
                      ? msg.isStreaming
                        ? 'Detective (speaking...)'
                        : 'Detective'
                      : msg.isStreaming
                        ? `${persona.name} (speaking...)`
                        : persona.name}
                  </div>
                </motion.div>
              ))}
              {isInterrogating &&
                !messages.some(m => m.role === 'witness' && m.isStreaming) && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="self-start max-w-[85%]"
                  >
                    <div className="bg-surface border border-border p-4 flex gap-1">
                      <div className="w-1.5 h-1.5 rounded-full bg-ink4 animate-bounce" />
                      <div className="w-1.5 h-1.5 rounded-full bg-ink4 animate-bounce [animation-delay:0.2s]" />
                      <div className="w-1.5 h-1.5 rounded-full bg-ink4 animate-bounce [animation-delay:0.4s]" />
                    </div>
                  </motion.div>
                )}
              <div ref={chatEndRef} />
            </div>

            <div className="bg-surface border-t border-border p-4 pb-24">
              {/* Voice toggle */}
              <div className="flex items-center gap-2 mb-4">
                {interrogationMode === 'voice' ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        if (liveConnected) {
                          liveAudioPlayerRef.current.flush();
                          stopLive();
                          return;
                        }
                        liveKickoffPendingRef.current = true;
                        startLive(
                          {
                            name: persona.name,
                            archetype: persona.archetype,
                            age: persona.age,
                            occupation: persona.occupation,
                            tells: persona.tells,
                            openingStatement: persona.openingStatement,
                            guiltyOf: persona.guiltyOf,
                            secret: persona.secret,
                          },
                          detections.map(d => d.label),
                          true
                        );
                      }}
                      className={`font-mono text-[9px] tracking-[2px] px-3 py-2 border uppercase flex items-center gap-2 ${
                        liveConnected
                          ? 'border-red-noir bg-red-noir/10 text-red-noir'
                          : 'border-border text-ink3 hover:border-red-noir/50'
                      }`}
                    >
                      <Mic className="w-3.5 h-3.5" />
                      {liveConnected ? 'Stop voice' : 'Reconnect voice'}
                    </button>
                    <span className="font-mono text-[8px] text-ink4 uppercase">
                      {liveConnected
                        ? liveStatus === 'witness_speaking'
                          ? 'Voice mode: witness speaking…'
                          : 'Voice mode: listening…'
                        : 'Voice mode: connecting…'}
                    </span>
                    {liveError && (
                      <span className="font-mono text-[8px] text-red-noir uppercase">
                        {liveError}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="font-mono text-[8px] text-ink4 uppercase">
                    Text mode active
                  </span>
                )}
              </div>

              {/* Evidence Strip */}
              <div className="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar border-b border-border/30">
                {detections.map((obj, i) => (
                  <button
                    key={i}
                    onClick={() =>
                      setUserInput(`Tell me about the ${obj.label}`)
                    }
                    className="flex-shrink-0 font-mono text-[8px] tracking-[2px] text-ink3 border border-border px-3 py-1.5 hover:bg-surface2 transition-all whitespace-nowrap"
                  >
                    {obj.label.toUpperCase()}
                  </button>
                ))}
              </div>

              <div className="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar">
                <button
                  onClick={handleAccuse}
                  className="w-full font-mono text-[10px] tracking-[4px] text-red-noir border border-red-noir/30 py-3 hover:bg-red-noir/5 transition-all uppercase"
                >
                  MAKE ACCUSATION
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={userInput}
                  onChange={e => setUserInput(e.target.value)}
                  onKeyPress={e => {
                    if (e.key !== 'Enter') return;
                    if (liveConnected && userInput.trim()) {
                      sendLiveUserText(userInput);
                      setUserInput('');
                    } else if (!liveConnected) sendMessage();
                  }}
                  placeholder={
                    liveConnected
                      ? 'Ask the witness (or speak)...'
                      : 'Ask the witness...'
                  }
                  className="w-full bg-bg border border-border px-4 py-3 font-serif text-sm text-ink placeholder:text-ink4 focus:outline-none focus:border-red-noir/50 transition-all"
                />
                <button
                  onClick={() => {
                    if (liveConnected) {
                      if (userInput.trim()) {
                        sendLiveUserText(userInput);
                      }
                      setUserInput('');
                    } else {
                      sendMessage();
                    }
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9px] tracking-[2px] text-red-noir px-3 py-1"
                >
                  SEND
                </button>
              </div>
            </div>

            {/* Contradiction Modal */}
            <AnimatePresence>
              {selectedContradiction && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
                  onClick={() => setSelectedContradiction(null)}
                >
                  <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.9, opacity: 0 }}
                    className="bg-surface border border-amber-noir p-8 max-w-md w-full relative"
                    onClick={e => e.stopPropagation()}
                  >
                    <div className="font-mono text-[10px] tracking-[5px] text-amber-noir uppercase mb-4">
                      Contradiction Caught
                    </div>
                    <p className="font-serif text-lg italic text-ink leading-relaxed mb-6">
                      "{selectedContradiction}"
                    </p>
                    <button
                      onClick={() => setSelectedContradiction(null)}
                      className="w-full font-mono text-[10px] tracking-[4px] text-amber-noir border border-amber-noir/30 py-3 hover:bg-amber-noir/5 transition-all uppercase"
                    >
                      CLOSE DOSSIER
                    </button>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {currentScreen === 'accusation' && !accusationOptions && (
          <motion.div
            key="accusation-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg items-center justify-center px-6"
          >
            <div className="w-full max-w-md border border-border bg-surface p-6 shadow-[0_18px_45px_rgba(0,0,0,0.5)] space-y-4">
              <div className="h-4 w-40 bg-border/40 rounded animate-pulse" />
              <div className="grid grid-cols-2 gap-3">
                <div className="h-10 bg-border/15 rounded animate-pulse" />
                <div className="h-10 bg-border/15 rounded animate-pulse" />
                <div className="col-span-2 h-10 bg-border/15 rounded animate-pulse" />
              </div>
              <div className="h-10 w-full bg-red-noir/60 rounded animate-pulse" />
            </div>
            <div className="mt-6 font-mono text-[9px] tracking-[3px] text-ink4 uppercase">
              Building accusation options…
            </div>
          </motion.div>
        )}

        {currentScreen === 'accusation' && accusationOptions && (
          <motion.div
            key="accusation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg overflow-y-auto p-6"
          >
            <div className="mb-12 text-center pt-12">
              <div className="font-mono text-[10px] tracking-[6px] text-red-noir uppercase mb-2">
                Final Verdict
              </div>
              <h2 className="font-display text-4xl text-ink tracking-widest">
                ACCUSATION
              </h2>
            </div>

            <div className="space-y-10 pb-24">
              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">
                  1. The Suspect
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.suspects.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedSuspect(s)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedSuspect === s
                          ? 'bg-red-noir text-white border-red-noir'
                          : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">
                  2. The Method
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.methods.map((m, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedMethod(m)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedMethod === m
                          ? 'bg-red-noir text-white border-red-noir'
                          : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">
                  3. The Motive
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.motives.map((m, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedMotive(m)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedMotive === m
                          ? 'bg-red-noir text-white border-red-noir'
                          : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">
                  4. The Theory
                </div>
                <textarea
                  value={theory}
                  onChange={e => setTheory(e.target.value)}
                  placeholder="Explain what happened..."
                  className="w-full bg-surface border border-border p-4 font-serif text-sm text-ink placeholder:text-ink4 focus:outline-none focus:border-red-noir/50 min-h-[120px] resize-none"
                />
              </section>

              <button
                disabled={
                  !selectedSuspect ||
                  !selectedMotive ||
                  !selectedMethod ||
                  !theory.trim()
                }
                onClick={handleSubmitVerdict}
                className="w-full font-display text-xs tracking-[5px] text-white uppercase bg-red-noir py-5 shadow-[0_0_25px_rgba(155,35,24,0.4)] active:scale-95 transition-all disabled:opacity-30 disabled:grayscale"
              >
                SUBMIT VERDICT
              </button>
            </div>
          </motion.div>
        )}

        {currentScreen === 'casefile' && !caseFile && (
          <motion.div
            key="casefile-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg items-center justify-center px-6"
          >
            <div className="w-full max-w-md border border-border bg-surface p-6 shadow-[0_18px_45px_rgba(0,0,0,0.5)] space-y-4">
              <div className="h-4 w-48 bg-border/40 rounded animate-pulse" />
              <div className="h-16 w-full bg-border/15 rounded animate-pulse" />
              <div className="h-16 w-full bg-border/15 rounded animate-pulse" />
            </div>
            <div className="mt-6 font-mono text-[9px] tracking-[3px] text-ink4 uppercase">
              Compiling case file…
            </div>
          </motion.div>
        )}

        {currentScreen === 'casefile' && (
          <motion.div
            key="casefile"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 bg-bg overflow-y-auto"
          >
            <div className="min-h-full flex flex-col">
              <div className="p-8 border-b-4 border-double border-border shrink-0">
                <div className="flex justify-between items-start mb-8 pt-8">
                  <div>
                    <div className="font-mono text-[10px] tracking-[4px] text-ink4 uppercase">
                      Dossier #882-B
                    </div>
                    <h2 className="font-display text-4xl text-ink tracking-tighter">
                      CASE FILE
                    </h2>
                    {detectiveName ? (
                      <div className="mt-2 font-mono text-[9px] tracking-[3px] text-red-noir uppercase">
                        Lead: Det. {detectiveName}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="px-8 pt-10 pb-24 max-w-3xl mx-auto w-full">
                <div className="space-y-12">
                  {caseFile ? (
                    <div className="bg-surface border border-border p-8 shadow-2xl relative">
                      <div className="absolute top-0 left-0 w-full h-1 bg-red-noir" />
                      <div className="absolute top-4 right-4 font-mono text-[8px] text-ink4">
                        FILE_REF: {caseFile.caseNumber}/X
                      </div>

                      <div className="mb-12 border-b border-border pb-8">
                        <div className="font-mono text-[10px] tracking-[4px] text-red-noir uppercase mb-2">
                          Official Case File
                        </div>
                        <h2 className="font-display text-2xl tracking-widest text-ink uppercase leading-tight">
                          Case #{caseFile.caseNumber}
                        </h2>
                        <div className="font-mono text-[9px] text-ink4 mt-1 uppercase tracking-wider">
                          {caseFile.date} · {caseFile.time}
                        </div>
                      </div>

                      <div className="space-y-10">
                        <section>
                          <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-2">
                            Incident Type
                          </div>
                          <div className="font-serif text-base text-ink font-medium">
                            {caseFile.incidentType}
                          </div>
                        </section>

                        <section>
                          <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-3">
                            Victim
                          </div>
                          <div className="space-y-2">
                            <div className="font-serif text-lg text-ink">
                              {caseFile.victim.name}, {caseFile.victim.age},{' '}
                              {caseFile.victim.occupation}
                            </div>
                            <p className="font-serif text-sm text-ink2 italic leading-relaxed">
                              {caseFile.victim.discovery}
                            </p>
                            <div className="inline-block font-mono text-[9px] tracking-wider text-red-noir border border-red-noir/20 px-2 py-0.5 uppercase">
                              {caseFile.victim.condition}
                            </div>
                          </div>
                        </section>

                        <section className="pt-6 border-t border-border">
                          <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-4">
                            Scene Report
                          </div>
                          <p className="font-serif text-base text-ink2 leading-relaxed whitespace-pre-line">
                            {caseFile.sceneReport}
                          </p>
                        </section>

                        <section className="pt-6 border-t border-border">
                          <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-3">
                            Witness on Scene
                          </div>
                          <div className="space-y-2">
                            <div className="font-serif text-lg text-ink">
                              {caseFile.witnessOnScene.name},{' '}
                              {caseFile.witnessOnScene.age},{' '}
                              {caseFile.witnessOnScene.occupation}
                            </div>
                            <p className="font-serif text-sm text-ink2 leading-relaxed">
                              {caseFile.witnessOnScene.reason}
                            </p>
                            <p className="font-serif text-sm text-ink3 italic leading-relaxed">
                              {caseFile.witnessOnScene.demeanor}
                            </p>
                          </div>
                        </section>

                        <section className="pt-6 border-t border-border">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-1.5">
                                Investigating Detective
                              </div>
                              <div className="font-serif text-sm text-ink font-medium uppercase tracking-wider">
                                {detectiveName || 'UNKNOWN'}
                              </div>
                            </div>
                            <div>
                              <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase mb-1.5">
                                Assigned
                              </div>
                              <div className="font-serif text-sm text-ink">
                                {caseFile.assignedDate}
                              </div>
                            </div>
                          </div>
                        </section>

                        <section className="pt-6 border-t border-border">
                          <div className="flex justify-between items-center">
                            <div className="font-mono text-[8px] tracking-[2px] text-ink4 uppercase">
                              Case Status
                            </div>
                            <div className="font-mono text-[10px] tracking-[2px] text-red-noir font-bold uppercase">
                              OPEN — AWAITING INTERROGATION
                            </div>
                          </div>
                        </section>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-surface border border-border p-6">
                      <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-2">
                        Official Case File
                      </div>
                      <p className="font-serif text-sm text-ink2 italic">
                        Case file still compiling.
                      </p>
                    </div>
                  )}

                  <button
                    onClick={() => {
                      if (hasPersona) {
                        navigateToScreen('witness');
                        return;
                      }
                      handleMeetWitness();
                    }}
                    className="w-full font-display text-xs tracking-[5px] text-white uppercase bg-red-noir py-5 shadow-[0_20px_40px_rgba(155,35,24,0.3)] active:scale-95 transition-all"
                  >
                    {hasPersona ? 'RETURN TO WITNESS' : 'MEET THE WITNESS'}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentScreen === 'verdict' && verdict && (
          <motion.div
            key="verdict"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 bg-bg overflow-y-auto"
          >
            <div className="min-h-full flex flex-col">
              <div className="p-8 border-b-4 border-double border-border shrink-0">
                <div className="flex justify-between items-start mb-8 pt-8">
                  <div>
                    <div className="font-mono text-[10px] tracking-[4px] text-ink4 uppercase">
                      Dossier #882-B
                    </div>
                    <h2 className="font-display text-4xl text-ink tracking-tighter">
                      CASE CLOSED
                    </h2>
                    {detectiveName ? (
                      <div className="mt-2 font-mono text-[9px] tracking-[3px] text-red-noir uppercase">
                        Lead: Det. {detectiveName}
                      </div>
                    ) : null}
                  </div>
                  <div
                    className={`px-4 py-2 border-2 font-display text-lg tracking-widest ${
                      verdict.correct
                        ? 'border-green-noir text-green-noir'
                        : 'border-red-noir text-red-noir'
                    } rotate-3`}
                  >
                    {verdict.correct ? 'SOLVED' : 'UNSOLVED'}
                  </div>
                </div>
              </div>

              <div className="px-8 pt-10 pb-24">
                <div className="bg-surface p-6 border-l-4 border-ink mb-10">
                  <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-2">
                    Official Verdict
                  </div>
                  <p className="font-serif text-xl text-ink leading-tight mb-4">
                    {verdict.verdict}
                  </p>
                  <p className="font-serif text-sm text-ink2 italic">
                    {verdict.explanation}
                  </p>
                </div>

                {verdict.oneTrueThing && (
                  <div className="bg-amber-noir/5 p-6 border border-amber-noir/30 mb-10 relative">
                    <div className="absolute -top-3 left-4 bg-bg px-2 font-mono text-[8px] text-amber-noir tracking-[3px] uppercase">
                      The Final Truth
                    </div>
                    <p className="font-serif text-lg italic text-ink leading-relaxed">
                      "{verdict.oneTrueThing}"
                    </p>
                  </div>
                )}

                <div className="space-y-12">
                  <section>
                    <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-1">
                      Timeline of Events
                    </div>
                    <div className="space-y-4">
                      {timeline.map((event, i) => (
                        <div key={i} className="flex gap-4">
                          <div className="font-mono text-[10px] text-ink4 pt-1">
                            0{i + 1}
                          </div>
                          <p className="font-serif text-sm text-ink leading-snug">
                            {event}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-1">
                      Testimony Review
                    </div>
                    <div className="space-y-3">
                      {(verdict.testimonyReview?.length ?? 0) === 0 &&
                      testimonyReview.length === 0 ? (
                        <div className="bg-surface p-3 border border-border">
                          <p className="font-serif text-sm text-ink2 italic">
                            No testimony recorded yet.
                          </p>
                        </div>
                      ) : (
                        (verdict.testimonyReview?.length
                          ? verdict.testimonyReview
                          : testimonyReview
                        ).map((review, i) => (
                          <div
                            key={i}
                            className="bg-surface p-3 border border-border"
                          >
                            <p className="font-serif text-sm text-ink italic mb-1">
                              "{review.quote}"
                            </p>
                            <div
                              className={`font-mono text-[8px] tracking-[2px] uppercase ${
                                review.status === 'CONTRADICTION'
                                  ? 'text-red-noir'
                                  : review.status === 'CRITICAL'
                                    ? 'text-amber-noir'
                                    : review.status === 'VERIFIED'
                                      ? 'text-green-noir'
                                      : 'text-ink4'
                              }`}
                            >
                              {review.status}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </section>

                  <section>
                    <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-1">
                      Interrogation Stats
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="border border-border p-4">
                        <div className="font-mono text-[8px] text-ink4 uppercase">
                          Contradictions Caught
                        </div>
                        <div className="font-display text-2xl text-ink">
                          {contradictionCount}
                        </div>
                      </div>
                      <div className="border border-border p-4">
                        <div className="font-mono text-[8px] text-ink4 uppercase">
                          Time Remaining
                        </div>
                        <div className="font-display text-2xl text-ink">
                          {formatTime(timeLeft)}
                        </div>
                      </div>
                    </div>
                  </section>

                  {detectiveProfile && (
                    <section>
                      <div className="bg-bg2 border border-border p-6 relative overflow-hidden">
                        <div className="absolute top-0 right-0 p-2 opacity-10">
                          <Scale className="w-12 h-12" />
                        </div>
                        <div className="font-mono text-[8px] tracking-[3px] text-amber-noir uppercase mb-4">
                          Permanent Record Updated
                        </div>
                        <div className="flex justify-between items-end">
                          <div>
                            <div className="font-mono text-[7px] text-ink4 uppercase">
                              Total Career Score
                            </div>
                            <div className="font-display text-3xl text-ink">
                              {detectiveProfile.totalScore}
                            </div>
                            <div className="mt-2 font-mono text-[7px] text-ink4 uppercase">
                              Cases Solved
                            </div>
                            <div className="font-display text-xl text-ink">
                              {detectiveProfile.casesSolved}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="font-mono text-[7px] text-ink4 uppercase">
                              Rating
                            </div>
                            <div className="font-display text-xl text-amber-noir">
                              {getProfileRating(detectiveProfile.totalScore)}
                            </div>
                          </div>
                        </div>
                        {detectiveProfile.badges.length > 0 && (
                          <div className="mt-4 pt-4 border-t border-border/30 flex gap-2 flex-wrap">
                            {detectiveProfile.badges.map(badge => (
                              <div
                                key={badge}
                                className="flex items-center gap-1 bg-surface px-2 py-1 border border-border"
                              >
                                <span className="font-mono text-[7px] text-ink2 uppercase">
                                  {badge.replace('_', ' ')}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                  <button
                    onClick={() => {
                      try {
                        localStorage.removeItem(STORAGE_KEY);
                      } catch {}
                      window.location.reload();
                    }}
                    className="w-full font-display text-xs tracking-[5px] text-ink uppercase bg-surface border border-border py-5 active:bg-surface2 transition-all"
                  >
                    NEW INVESTIGATION
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {currentScreen === 'camera' && (
          <motion.div
            key="camera"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg"
          >
            <div className="flex-1 relative overflow-hidden bg-bg2">
              <div ref={cameraFrameRef} className="absolute inset-0">
                <div
                  className="absolute"
                  style={
                    videoBox
                      ? {
                          left: videoBox.x,
                          top: videoBox.y,
                          width: videoBox.width,
                          height: videoBox.height,
                        }
                      : { inset: 0 }
                  }
                >
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={updateVideoBox}
                    className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-700 ${cameraStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
                  />

                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 w-full h-full object-contain hidden"
                  />

                  {/* Detection Layer */}
                  <div className="absolute inset-0 z-20">
                    {detections.map((obj, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, scale: 0.88 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={`absolute border ${obj.flagged ? 'border-amber-noir bg-amber-noir/10' : 'border-greenbr bg-greenbr/10'} animate-box-pulse`}
                        style={{
                          left: `${obj.x}%`,
                          top: `${obj.y}%`,
                          width: `${obj.w}%`,
                          height: `${obj.h}%`,
                        }}
                      >
                        <div className="absolute bottom-full left-0 mb-0.5 flex items-center gap-0">
                          <span
                            className={`font-mono text-[8px] tracking-tight ${obj.flagged ? 'text-amber-noir' : 'text-greenbr'} bg-surface/90 px-2 py-0.5 whitespace-nowrap border border-border/50`}
                          >
                            {obj.label.toUpperCase()}
                          </span>
                          {obj.flagged && (
                            <span className="bg-amber-noir/20 text-amber-noir text-[8px] px-1 py-0.5">
                              ⚠
                            </span>
                          )}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>
              </div>

              {/* CRT Overlays */}
              <div className="absolute inset-0 z-10 pointer-events-none bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,rgba(0,0,0,0.03)_3px,rgba(0,0,0,0.03)_4px)]" />
              <div className="absolute left-0 right-0 h-1 z-10 pointer-events-none bg-gradient-to-b from-transparent via-greenbr/20 to-transparent animate-scandown" />
              <div className="absolute inset-0 z-10 pointer-events-none bg-radial from-transparent via-transparent to-ink/15" />

              {/* Corner Brackets */}
              <div
                className={`absolute top-4 left-4 w-6 h-6 z-20 border-t-2 border-l-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`}
              />
              <div
                className={`absolute top-4 right-4 w-6 h-6 z-20 border-t-2 border-r-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`}
              />
              <div
                className={`absolute bottom-4 left-4 w-6 h-6 z-20 border-b-2 border-l-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`}
              />
              <div
                className={`absolute bottom-4 right-4 w-6 h-6 z-20 border-b-2 border-r-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`}
              />

              {/* HUD */}
              <div className="absolute top-4 left-12 z-20 flex flex-col gap-1 pointer-events-none">
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-red-noir animate-breathe" />
                  <span className="font-mono text-[9px] tracking-[3px] text-greenbr uppercase">
                    {isScanning ? 'SCANNING' : 'LIVE'}
                  </span>
                  {analysisError && (
                    <span className="ml-2 font-mono text-[8px] tracking-[1px] text-red-noir bg-red-noir/10 px-2 py-0.5 border border-red-noir/30">
                      ANALYSIS INCOMPLETE
                    </span>
                  )}
                </div>
              </div>

              <div className="absolute top-4 right-12 z-20 font-mono text-[9px] tracking-[2px] text-greenbr text-right pointer-events-none">
                OBJECTS
                <span className="block text-[22px] font-display text-ink tracking-normal leading-none">
                  {detections.length}
                </span>
              </div>

              {/* Scanning Overlay */}
              {isScanning && (
                <div className="absolute inset-0 z-30 bg-bg/85 flex flex-col items-center justify-center gap-4">
                  <div className="w-12 h-12 border-2 border-greenbr/20 border-t-greenbr rounded-full animate-spin-slow" />
                  <div className="font-mono text-[10px] tracking-[4px] text-greenbr uppercase">
                    Analysing scene…
                  </div>
                  <p className="font-serif text-sm italic text-ink3 text-center px-12 leading-relaxed">
                    "I remember this room. Something happened here that I can't
                    quite explain…"
                  </p>
                </div>
              )}

              {/* Camera Denied */}
              {cameraStatus === 'idle' && (
                <div className="absolute inset-0 z-35 flex flex-col items-center justify-center gap-4 px-12 text-center bg-bg/95">
                  <Camera className="w-12 h-12 text-ink3" />
                  <h3 className="font-display text-base tracking-[3px] text-ink uppercase">
                    ENABLE CAMERA TO BEGIN
                  </h3>
                  <p className="font-serif text-sm italic text-ink3 leading-relaxed max-w-lg">
                    Tap the button below and allow camera permission to scan the
                    room and generate your witness.
                  </p>
                  <button
                    onClick={startCamera}
                    className="mt-2 font-display text-xs tracking-[3px] text-ink border border-border px-8 py-3 active:bg-surface2 transition-all"
                  >
                    ENABLE CAMERA
                  </button>
                </div>
              )}

              {cameraStatus === 'denied' && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 px-12 text-center bg-bg">
                  <Camera className="w-12 h-12 text-ink3" />
                  <h3 className="font-display text-base tracking-[3px] text-ink uppercase">
                    CAMERA ACCESS DENIED
                  </h3>
                  <p className="font-serif text-sm italic text-ink3 leading-relaxed">
                    {cameraIssue ??
                      'Enable camera access in your browser settings, then reload the page to begin your investigation.'}
                  </p>
                  <button
                    onClick={startCamera}
                    className="mt-4 font-display text-xs tracking-[3px] text-ink border border-border px-8 py-3 active:bg-surface2 transition-all"
                  >
                    TRY AGAIN
                  </button>
                </div>
              )}

              {cameraStatus === 'unsupported' && (
                <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-4 px-12 text-center bg-bg">
                  <AlertCircle className="w-12 h-12 text-ink3" />
                  <h3 className="font-display text-base tracking-[3px] text-ink uppercase">
                    CAMERA NOT AVAILABLE
                  </h3>
                  <p className="font-serif text-sm italic text-ink3 leading-relaxed max-w-lg">
                    {cameraIssue ??
                      'This browser or context does not allow camera access. Open the app in a modern browser over HTTPS.'}
                  </p>
                </div>
              )}
            </div>

            {/* Bottom Panel */}
            <div className="bg-surface border-t border-border px-6 pt-4 pb-24">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1.5 h-1.5 rounded-full bg-greenbr animate-breathe" />
                <span className="font-mono text-[10px] tracking-[3px] text-greenbr uppercase">
                  {isScanning
                    ? 'Processing...'
                    : detections.length > 0
                      ? 'Analysis Complete'
                      : 'Ready to scan'}
                </span>
              </div>

              <div className="font-serif text-[clamp(14px,4vw,16px)] font-light italic text-ink2 leading-relaxed mb-4 pl-4 border-l-2 border-redmute min-h-[52px]">
                {isScanning
                  ? '"Hold steady. I\'m trying to remember..." '
                  : witnessQuote
                    ? `"${witnessQuote}"`
                    : detections.length > 0
                      ? '"I see it now. The details are coming back... Look at those items. They tell a story."'
                      : '"Aim your camera at the scene. I\'ll tell you what I remember…"'}
              </div>

              <div className="flex flex-wrap gap-2 mb-4 max-h-[72px] overflow-y-auto">
                {detections.map((obj, i) => (
                  <motion.span
                    key={i}
                    initial={{ opacity: 0, y: -5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`font-mono text-[9px] tracking-widest uppercase border ${obj.flagged ? 'border-redmute text-amber-noir' : 'border-green-noir text-greenbr'} px-3 py-1`}
                  >
                    {obj.label}
                  </motion.span>
                ))}
              </div>

              <div className="flex items-center justify-center gap-6 py-2">
                <div className="flex-1 text-center">
                  <span className="font-mono text-[9px] tracking-[4px] text-ink2 uppercase">
                    TAP TO SCAN
                  </span>
                </div>
                <button
                  onClick={cameraStatus === 'live' ? captureScene : startCamera}
                  className={`w-16 h-16 rounded-full border-4 border-ink2 flex items-center justify-center transition-all active:scale-90 relative ${isScanning ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <div
                    className={`absolute inset-1 rounded-full bg-ink transition-all ${isScanning ? 'bg-amber-noir animate-pulse' : ''}`}
                  />
                </button>
                <div className="flex-1" />
              </div>

              {showProceed && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4"
                >
                  <button
                    onClick={handleMeetWitness}
                    className="w-full font-display text-xs tracking-[5px] text-white uppercase bg-red-noir py-4 shadow-[0_0_18px_rgba(155,35,24,0.3)] active:scale-95 transition-all"
                  >
                    MEET THE WITNESS →
                  </button>
                </motion.div>
              )}

              {caseFile && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-3"
                >
                  <button
                    onClick={() => navigateToScreen('casefile')}
                    className="w-full font-mono text-[10px] tracking-[3px] text-ink border border-border py-3 active:bg-surface2 transition-all uppercase"
                  >
                    OPEN CASE FILE
                  </button>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation & Utilities */}
      {[
        'camera',
        'witness',
        'interrogation',
        'accusation',
        'casefile',
        'verdict',
      ].includes(currentScreen) && (
        <div className="fixed bottom-0 left-0 right-0 h-[62px] bg-bg/95 border-t border-border z-50 flex items-stretch">
          <button
            onClick={() => navigateToScreen('camera')}
            className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'camera' ? 'border-red-noir' : 'border-transparent'}`}
          >
            <Camera
              className={`w-4 h-4 ${currentScreen === 'camera' ? 'text-red-noir' : 'text-ink4'}`}
            />
            <span
              className={`font-mono text-[7px] tracking-wider uppercase ${currentScreen === 'camera' ? 'text-red-noir' : 'text-ink4'}`}
            >
              Scene
            </span>
          </button>
          <button
            onClick={() => {
              if (!hasPersona) return;
              navigateToScreen('witness');
            }}
            className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'witness' ? 'border-red-noir' : 'border-transparent'} ${!hasPersona ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <Eye
              className={`w-4 h-4 ${currentScreen === 'witness' ? 'text-red-noir' : 'text-ink4'}`}
            />
            <span
              className={`font-mono text-[7px] tracking-wider uppercase ${currentScreen === 'witness' ? 'text-red-noir' : 'text-ink4'}`}
            >
              Witness
            </span>
          </button>
          <button
            onClick={() => {
              if (!hasInterrogation) return;
              navigateToScreen('interrogation');
            }}
            className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'interrogation' ? 'border-red-noir' : 'border-transparent'} ${!hasInterrogation ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <Mic
              className={`w-4 h-4 ${currentScreen === 'interrogation' ? 'text-red-noir' : 'text-ink4'}`}
            />
            <span
              className={`font-mono text-[7px] tracking-wider uppercase ${currentScreen === 'interrogation' ? 'text-red-noir' : 'text-ink4'}`}
            >
              Interrogate
            </span>
          </button>
          <button
            onClick={() => {
              if (!hasAccusation) return;
              navigateToScreen('accusation');
            }}
            className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'accusation' ? 'border-red-noir' : 'border-transparent'} ${!hasAccusation ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <Scale
              className={`w-4 h-4 ${currentScreen === 'accusation' ? 'text-red-noir' : 'text-ink4'}`}
            />
            <span
              className={`font-mono text-[7px] tracking-wider uppercase ${currentScreen === 'accusation' ? 'text-red-noir' : 'text-ink4'}`}
            >
              Accuse
            </span>
          </button>
          <button
            onClick={() => {
              if (!hasCaseFile) return;
              navigateToScreen('casefile');
            }}
            disabled={!hasCaseFile}
            aria-disabled={!hasCaseFile}
            className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${isCaseFileActive ? 'border-red-noir' : 'border-transparent'} ${!hasCaseFile ? 'opacity-30 cursor-not-allowed' : ''}`}
          >
            <FileText
              className={`w-4 h-4 ${isCaseFileActive ? 'text-red-noir' : 'text-ink4'}`}
            />
            <span
              className={`font-mono text-[7px] tracking-wider uppercase ${isCaseFileActive ? 'text-red-noir' : 'text-ink4'}`}
            >
              Case File
            </span>
          </button>
        </div>
      )}

      {currentScreen !== 'splash' && currentScreen !== 'onboarding' && (
        <button
          onClick={() => {
            if (currentScreen === 'onboarding') navigateToScreen('splash');
            else if (currentScreen === 'camera') navigateToScreen('onboarding');
            else navigateToScreen('camera');
          }}
          className="fixed top-[max(12px,env(safe-area-inset-top))] left-3 md:left-6 z-[60] w-11 h-11 flex items-center justify-center bg-bg/85 border border-border backdrop-blur-md active:bg-surface2 transition-all"
          aria-label="Go back"
        >
          <ChevronLeft className="w-3 h-3 text-ink2" />
        </button>
      )}

      {currentScreen !== 'splash' && (
        <button
          onClick={toggleTheme}
          className="fixed top-4 right-6 z-[60] w-11 h-11 rounded-full bg-surface2 border border-borderlt flex items-center justify-center text-lg shadow-lg active:scale-90 transition-all"
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      )}
    </div>
  );
}
