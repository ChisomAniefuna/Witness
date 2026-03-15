/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Camera, Eye, Mic, Scale, FileText, ChevronLeft, Sun, Moon, AlertCircle } from 'lucide-react';
import { analyzeScene, generateWitnessPersona, getInterrogationResponse, detectContradiction, checkSafety, getEngagementResponse, getAccusationOptions, evaluateAccusation, generateCaseFileTimeline, WitnessPersona } from './services/geminiService';

type Screen = 'splash' | 'onboarding' | 'camera' | 'witness' | 'interrogation' | 'accusation' | 'casefile';

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
  isContradiction?: boolean;
  contradictionQuote?: string;
}

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('splash');
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    return saved ? saved === 'dark' : true;
  });
  const [cameraStatus, setCameraStatus] = useState<'idle' | 'live' | 'denied'>('idle');
  const [isScanning, setIsScanning] = useState(false);
  const [detections, setDetections] = useState<DetectionObject[]>([]);
  const [showProceed, setShowProceed] = useState(false);
  
  const [persona, setPersona] = useState<WitnessPersona | null>(null);
  const [isGeneratingPersona, setIsGeneratingPersona] = useState(false);
  const [contradictionCount, setContradictionCount] = useState(0);
  const [detectiveName, setDetectiveName] = useState('');
  const [caughtContradictions, setCaughtContradictions] = useState<{ quote1: string, quote2: string }[]>([]);
  const [selectedContradiction, setSelectedContradiction] = useState<string | null>(null);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [userInput, setUserInput] = useState('');
  const [timeLeft, setTimeLeft] = useState(180); // 3 minutes
  const [isInterrogating, setIsInterrogating] = useState(false);
  const [witnessQuote, setWitnessQuote] = useState<string | null>(null);
  const [analysisError, setAnalysisError] = useState(false);
  const [lastMessageTime, setLastMessageTime] = useState(Date.now());
  const [shortMessageCount, setShortMessageCount] = useState(0);

  const [accusationOptions, setAccusationOptions] = useState<{ suspects: string[], methods: string[], motives: string[] } | null>(null);
  const [selectedSuspect, setSelectedSuspect] = useState<string | null>(null);
  const [selectedMotive, setSelectedMotive] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<{ correct: boolean, verdict: string, explanation: string } | null>(null);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [isSafetyFlagged, setIsSafetyFlagged] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const toggleTheme = () => {
    setIsDark(prev => !prev);
  };

  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [isDark]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        streamRef.current = stream;
        setCameraStatus('live');
      }
    } catch (err) {
      console.error('Camera error:', err);
      setCameraStatus('denied');
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setCameraStatus('idle');
  };

  useEffect(() => {
    if (currentScreen !== 'camera') {
      stopCamera();
    }
    return () => stopCamera();
  }, [currentScreen]);

  useEffect(() => {
    if (currentScreen === 'interrogation' && timeLeft > 0) {
      const timer = setInterval(() => {
        setTimeLeft(prev => prev - 1);
        
        // Engagement Monitor: Fire if no message in 30 seconds
        if (Date.now() - lastMessageTime > 30000 && !isInterrogating && persona) {
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
    setAnalysisError(false);
    setWitnessQuote(null);

    try {
      const result = await analyzeScene(imageData);
      setDetections(result.objects);
      setWitnessQuote(result.witnessReaction);
      
      setIsScanning(false);
      setShowProceed(true);
    } catch (err) {
      console.error('Analysis error:', err);
      setAnalysisError(true);
      
      // Fallback to mock data
      const mockDetections = [
        { label: 'Blood Splatter', x: 45, y: 30, w: 15, h: 15, flagged: true, description: 'A dark, viscous stain that tells a story of violence.' },
        { label: 'Discarded Glove', x: 20, y: 70, w: 10, h: 10, flagged: true, description: 'Latex, torn at the thumb. Someone was in a hurry.' },
        { label: 'Broken Glass', x: 65, y: 55, w: 12, h: 12, flagged: false, description: 'A shattered tumbler. The last drink was never finished.' }
      ];
      setDetections(mockDetections);
      const fallbackQuote = "I... I shouldn't have come back here. The air feels heavy with what happened.";
      setWitnessQuote(fallbackQuote);
      
      setIsScanning(false);
      setShowProceed(true);
    }
  };

  const handleMeetWitness = async () => {
    setIsGeneratingPersona(true);
    setCurrentScreen('witness');
    try {
      const p = await generateWitnessPersona(detections.map(d => ({ label: d.label, description: d.description })));
      setPersona(p);
      setMessages([{ role: 'witness', text: p.openingStatement }]);
      setLastMessageTime(Date.now());
    } catch (err) {
      console.error('Persona generation error:', err);
      // Fallback pool
      const fallbacks: WitnessPersona[] = [
        {
          name: 'JACK',
          archetype: 'The Nervous Wreck',
          age: 42,
          occupation: 'Night Watchman',
          tells: ['Twitching eye', 'Wringing hands'],
          openingStatement: '"I was here when it happened. I heard everything. I saw him leave. At least… I think that\'s what I saw."',
          guiltyOf: 'Accidental Manslaughter',
          secret: 'He was sleeping on the job when the crime occurred.',
          crimeSceneNarrative: 'I was just doing my rounds when I saw a shadow near the window. By the time I got there, it was too late.',
          objectConnections: [],
          avatarUrl: 'https://picsum.photos/seed/jack/400/400'
        },
        {
          name: 'SARAH',
          archetype: 'The Cold Socialite',
          age: 29,
          occupation: 'Art Dealer',
          tells: ['Adjusting pearls', 'Checking watch'],
          openingStatement: '"This is all so... inconvenient. I have a gallery opening in an hour. Can we make this quick?"',
          guiltyOf: 'Grand Larceny',
          secret: 'She swapped the original painting for a forgery years ago.',
          crimeSceneNarrative: 'I was simply admiring the collection when the lights flickered. When they came back on, the room was in disarray.',
          objectConnections: [],
          avatarUrl: 'https://picsum.photos/seed/sarah/400/400'
        },
        {
          name: 'MICHAEL',
          archetype: 'The Bitter Academic',
          age: 58,
          occupation: 'History Professor',
          tells: ['Polishing glasses', 'Clearing throat'],
          openingStatement: '"History repeats itself, detective. Usually as a tragedy. This room... it feels like a tomb."',
          guiltyOf: 'Blackmail',
          secret: 'He was being paid to keep quiet about a local scandal.',
          crimeSceneNarrative: 'I was researching in the library when I heard a struggle. I didn\'t want to get involved. I\'ve seen enough trouble.',
          objectConnections: [],
          avatarUrl: 'https://picsum.photos/seed/michael/400/400'
        }
      ];
      const fallback = fallbacks[Math.floor(Math.random() * fallbacks.length)];
      setPersona(fallback);
      setMessages([{ role: 'witness', text: fallback.openingStatement }]);
    } finally {
      setIsGeneratingPersona(false);
    }
  };

  const handleRescan = () => {
    setShowProceed(false);
    setDetections([]);
    setWitnessQuote(null);
    setAnalysisError(false);
  };

  const sendMessage = async () => {
    if (!userInput.trim() || isInterrogating || !persona) return;
    
    const text = userInput.trim();
    setUserInput('');
    setLastMessageTime(Date.now());

    // 1. SAFETY MONITOR
    const safety = await checkSafety(text);
    if (!safety.safe) {
      setIsSafetyFlagged(true);
      setMessages(prev => [...prev, 
        { role: 'user', text },
        { role: 'witness', text: "Let's focus on the case... I don't want to talk about that." }
      ]);
      return;
    }

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
      // Engagement Monitor: Fire if 3 consecutive short messages
      if (shortMessageCount >= 2) {
        setShortMessageCount(0);
        const engagementResponse = await getEngagementResponse(persona);
        setMessages(prev => [...prev, { role: 'witness', text: engagementResponse }]);
        setIsInterrogating(false);
        return;
      }

      // 2. PERSONA GUARD (Implicitly handled by getInterrogationResponse with persona details)
      // 3. INTERROGATION RESPONSE
      let response = await getInterrogationResponse(newMessages, persona, detections.map(d => d.label), detectiveName);
      
      // 4. CONTRADICTION DETECTOR
      const contradictionCheck = await detectContradiction([...newMessages, { role: 'witness', text: response }]);
      
      let finalMsg: Message = { role: 'witness', text: response };
      
      if (contradictionCheck.contradiction) {
        finalMsg.isContradiction = true;
        finalMsg.contradictionQuote = contradictionCheck.quote;
        // We don't increment counter here, we increment when the user TAPS it (as per "catching" them)
        // Actually, prompt says "increment the contradiction counter in the header bar" when it fires.
        setContradictionCount(prev => prev + 1);
      }

      setMessages(prev => [...prev, finalMsg]);
    } catch (err) {
      console.error('Interrogation error:', err);
      setMessages(prev => [...prev, { role: 'witness', text: 'I... I can\'t remember. My head is spinning.' }]);
    } finally {
      setIsInterrogating(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleAccuse = async () => {
    if (!persona) return;
    setCurrentScreen('accusation');
    try {
      const options = await getAccusationOptions(detections.map(d => d.label), persona);
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
    if (!selectedSuspect || !selectedMotive || !selectedMethod || !persona) return;
    
    setCurrentScreen('casefile');
    try {
      const res = await evaluateAccusation(
        { suspect: selectedSuspect, method: selectedMethod, motive: selectedMotive },
        { witness: persona.name, objects: detections.map(d => d.label), guiltyOf: persona.guiltyOf }
      );
      setVerdict(res);
      
      const t = await generateCaseFileTimeline(persona, detections.map(d => d.label));
      setTimeline(t);
    } catch (err) {
      console.error('Verdict error:', err);
    }
  };

  return (
    <div className={`w-full h-full flex flex-col ${isDark ? 'bg-bg text-ink' : 'bg-bg text-ink'}`}>
      <AnimatePresence mode="wait">
        {currentScreen === 'splash' && (
          <motion.div
            key="splash"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg overflow-hidden"
          >
            {/* Background Texture */}
            <div className="absolute inset-0 z-0 opacity-[0.03] pointer-events-none bg-[url('https://www.transparenttextures.com/patterns/pinstripe.png')]" />
            
            {/* Massive Background Typography */}
            <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none select-none overflow-hidden">
              <motion.h1 
                initial={{ scale: 1.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 0.04 }}
                transition={{ duration: 1.2, ease: "easeOut" }}
                className="font-display text-[45vw] text-ink leading-none tracking-tighter rotate-[-10deg] translate-y-[-5%]"
              >
                WITNESS
              </motion.h1>
            </div>

            {/* Main Content */}
            <div className="relative z-20 flex flex-col items-center text-center max-w-lg px-6">
              <motion.div 
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2 }}
                className="w-14 h-14 rounded-full border border-red-noir/30 flex items-center justify-center mb-12 relative"
              >
                <div className="w-2 h-2 rounded-full bg-red-noir animate-pulse" />
                <div className="absolute inset-[-10px] rounded-full border border-red-noir/10 animate-ping [animation-duration:4s]" />
              </motion.div>
              
              <motion.div
                initial={{ y: 40, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.4, duration: 0.8, ease: "circOut" }}
              >
                <h1 className="font-display text-[clamp(72px,18vw,140px)] text-ink tracking-tighter leading-[0.8] mb-10 uppercase">
                  WITNESS
                </h1>
                <div className="h-px w-32 bg-red-noir/40 mx-auto mb-10" />
                <p className="font-serif text-[clamp(18px,5vw,24px)] italic font-light text-ink2 leading-relaxed mb-16 max-w-sm mx-auto text-center">
                  "The room remembers what the eyes forget. Point your lens at the truth."
                </p>
              </motion.div>
              
              <motion.button
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.8 }}
                onClick={() => setCurrentScreen('onboarding')}
                className="group relative w-full max-w-xs font-display text-xs tracking-[8px] text-white uppercase bg-red-noir py-7 shadow-[0_25px_50px_rgba(155,35,24,0.3)] hover:shadow-[0_30px_60px_rgba(155,35,24,0.4)] active:scale-95 transition-all overflow-hidden"
              >
                <span className="relative z-10">BEGIN INVESTIGATION</span>
                <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
              </motion.button>
            </div>

            {/* Corner Accents */}
            <div className="absolute top-10 left-10 w-16 h-px bg-red-noir/20" />
            <div className="absolute top-10 left-10 w-px h-16 bg-red-noir/20" />
            <div className="absolute bottom-10 right-10 w-16 h-px bg-red-noir/20" />
            <div className="absolute bottom-10 right-10 w-px h-16 bg-red-noir/20" />
          </motion.div>
        )}

        {currentScreen === 'onboarding' && (
          <motion.div
            key="onboarding"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col justify-end bg-bg2"
          >
            <div className="absolute inset-x-0 top-0 bottom-[45%] flex items-center justify-center overflow-hidden pointer-events-none">
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[clamp(200px,60vw,320px)] h-[clamp(200px,60vw,320px)] rounded-full bg-radial from-amber-noir/20 to-transparent" />
              <svg className="w-[clamp(280px,90vw,460px)] h-auto block relative z-10" viewBox="0 0 360 320">
                <defs>
                  <radialGradient id="og" cx="50%" cy="40%" r="55%">
                    <stop offset="0%" stopColor="#e0a820" stopOpacity=".3" />
                    <stop offset="100%" stopColor="#e0a820" stopOpacity="0" />
                  </radialGradient>
                  <linearGradient id="ig" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="#e0a820" stopOpacity=".58" />
                    <stop offset="100%" stopColor="#e0a820" stopOpacity=".03" />
                  </linearGradient>
                </defs>
                <line x1="0" y1="295" x2="360" y2="295" stroke="#1a1610" strokeWidth="1" />
                <ellipse cx="180" cy="178" rx="110" ry="128" fill="url(#og)" />
                <rect x="110" y="42" width="140" height="253" fill="#0a0805" stroke="#221c0a" strokeWidth="1.5" />
                <polygon points="110,42 148,47 148,291 110,291" fill="#0c0a06" stroke="#1c1608" strokeWidth="1" />
                <rect x="148" y="42" width="102" height="253" fill="url(#ig)" />
                <polygon points="110,295 250,295 296,320 64,320" fill="#e0a820" opacity=".05" />
                <ellipse cx="199" cy="100" rx="14" ry="16" fill="#020201" />
                <path d="M184 118 Q199 108 214 118 L220 145 Q199 138 178 145 Z" fill="#020201" />
                <rect x="184" y="143" width="30" height="112" fill="#020201" />
                <path d="M184 150 L171 215 L180 217 L190 155 Z" fill="#020201" />
                <path d="M214 150 L227 211 L236 209 L225 148 Z" fill="#020201" />
                <path d="M184 253 L177 295 L188 295 L191 253 Z" fill="#020201" />
                <path d="M214 253 L221 295 L210 295 L207 253 Z" fill="#020201" />
                <ellipse cx="199" cy="295" rx="32" ry="5" fill="#010100" opacity=".7" />
              </svg>
            </div>

            <div className="relative z-10 bg-bg border-t border-border px-6 pt-8 pb-12">
              <div className="font-mono text-[9px] tracking-[5px] text-red-noir uppercase mb-4 animate-flicker">The Experience</div>
              <h2 className="font-serif text-[clamp(22px,6vw,28px)] font-light text-ink leading-relaxed mb-4">
                Someone was here.<br /><em className="italic text-ink2">Now they're not.</em>
              </h2>
              <p className="font-serif text-[clamp(14px,4vw,16px)] font-light italic text-ink3 leading-relaxed mb-8">
                Point your camera at any real room. A witness inside it remembers everything. Your job: find what they're hiding.
              </p>

              <div className="mb-10">
                <div className="flex items-center gap-4 border-b border-border pb-2">
                  <div className="font-mono text-[10px] tracking-[2px] text-ink4 uppercase whitespace-nowrap">Badge Name:</div>
                  <input
                    type="text"
                    value={detectiveName}
                    onChange={(e) => setDetectiveName(e.target.value)}
                    placeholder="REQUIRED"
                    className="flex-1 bg-transparent border-none font-mono text-sm tracking-[3px] text-ink placeholder:text-ink4/30 focus:outline-none uppercase"
                  />
                </div>
              </div>

              <div className="flex gap-2 mb-8">
                <div className="w-5 h-1.5 rounded-sm bg-red-noir" />
                <div className="w-1.5 h-1.5 rounded-full bg-border" />
                <div className="w-1.5 h-1.5 rounded-full bg-border" />
              </div>
              <button
                onClick={() => {
                  if (detectiveName.trim()) {
                    setCurrentScreen('camera');
                  }
                }}
                disabled={!detectiveName.trim()}
                className={`w-full font-display text-xs tracking-[5px] text-white uppercase py-4 shadow-[0_0_18px_rgba(155,35,24,0.3)] active:scale-95 transition-all ${!detectiveName.trim() ? 'bg-ink4 cursor-not-allowed opacity-50' : 'bg-red-noir cursor-pointer'}`}
              >
                ENTER THE SCENE
              </button>
            </div>
          </motion.div>
        )}

        {currentScreen === 'witness' && isGeneratingPersona && (
          <motion.div
            key="witness-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col items-center justify-center bg-bg p-12 text-center"
          >
            <div className="relative mb-8">
              <div className="w-24 h-24 rounded-full border border-red-noir/20 animate-spin [animation-duration:3s]" />
              <div className="absolute inset-0 flex items-center justify-center text-3xl">🕵️</div>
            </div>
            <h3 className="font-display text-lg tracking-[5px] text-ink uppercase mb-4">Locating Witness</h3>
            <p className="font-serif text-sm italic text-ink3 leading-relaxed max-w-xs">
              "Every room has a ghost. I'm trying to find the one that's still breathing..."
            </p>
            <div className="mt-8 flex gap-1">
              <div className="w-1.5 h-1.5 rounded-full bg-red-noir animate-bounce" />
              <div className="w-1.5 h-1.5 rounded-full bg-red-noir animate-bounce [animation-delay:0.2s]" />
              <div className="w-1.5 h-1.5 rounded-full bg-red-noir animate-bounce [animation-delay:0.4s]" />
            </div>
          </motion.div>
        )}

        {currentScreen === 'witness' && !isGeneratingPersona && persona && (
          <motion.div
            key="witness"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg overflow-hidden"
          >
            {/* Header Section - Editorial Style */}
            <div className="relative h-[clamp(240px,45vh,380px)] flex-shrink-0 bg-bg2 border-b border-border overflow-hidden">
              {/* Background Accents */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 left-0 w-full h-full bg-radial-[circle_at_20%_30%] from-red-noir/10 to-transparent" />
                <div className="absolute -right-20 -top-20 w-64 h-64 rounded-full border border-red-noir/5" />
              </div>

              {/* Vertical Rail Text */}
              <div className="absolute left-6 top-1/2 -translate-y-1/2 h-40 flex items-center justify-center pointer-events-none">
                <div className="rotate-180 [writing-mode:vertical-rl] font-mono text-[9px] tracking-[6px] text-ink4 uppercase opacity-40">
                  DOSSIER • {persona.archetype} • DOSSIER
                </div>
              </div>

              {/* Confidential Stamp */}
              <div className="absolute top-8 right-8 pointer-events-none">
                <div className="border-2 border-red-noir/40 px-3 py-1.5 rotate-12 flex flex-col items-center">
                  <div className="font-display text-[10px] tracking-[4px] text-red-noir/60 uppercase leading-none mb-0.5">CONFIDENTIAL</div>
                  <div className="font-mono text-[7px] tracking-[2px] text-red-noir/40 uppercase">EYES ONLY</div>
                </div>
              </div>

              {/* Main Header Content */}
              <div className="absolute inset-0 flex flex-col justify-end p-8 pl-16">
                <div className="flex items-end gap-6 mb-4">
                  <div className="relative group">
                    <div className="w-[clamp(100px,25vw,130px)] h-[clamp(100px,25vw,130px)] bg-bg border border-border p-1.5 shadow-2xl relative z-10">
                      <div className="w-full h-full overflow-hidden relative">
                        {persona.avatarUrl ? (
                          <img src={persona.avatarUrl} alt={persona.name} className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all duration-700" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-4xl bg-bg2">🕵️</div>
                        )}
                        <div className="absolute inset-0 border border-white/10 pointer-events-none" />
                      </div>
                    </div>
                    {/* Decorative Shadow/Offset */}
                    <div className="absolute -bottom-2 -right-2 w-full h-full border border-red-noir/20 -z-0" />
                  </div>

                  <div className="flex-1 pb-2">
                    <div className="font-mono text-[10px] tracking-[4px] text-red-noir uppercase mb-2">SUBJECT IDENTIFIED</div>
                    <h2 className="font-display text-[clamp(32px,10vw,52px)] font-normal text-ink tracking-tight leading-[0.9] uppercase">
                      {persona.name}
                    </h2>
                  </div>
                </div>
              </div>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto bg-bg">
              <div className="max-w-2xl mx-auto px-8 py-10 space-y-12">
                
                {/* Opening Statement */}
                <section>
                  <div className="flex items-center gap-4 mb-6">
                    <div className="h-px flex-1 bg-border" />
                    <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase">Initial Contact</div>
                    <div className="h-px w-8 bg-border" />
                  </div>
                  <p className="font-serif text-[clamp(18px,5vw,22px)] font-light italic text-ink leading-relaxed text-center px-4">
                    "{persona.openingStatement}"
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
                          "{persona.crimeSceneNarrative}"
                        </p>
                      </div>
                    </section>

                    {/* Evidence Links */}
                    {persona.objectConnections.length > 0 && (
                      <section>
                        <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-6 flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-red-noir" />
                          Evidence Connections
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                          {persona.objectConnections.map((conn, i) => (
                            <div key={i} className="group flex items-start gap-4 p-4 bg-bg border border-border hover:border-red-noir/30 transition-colors">
                              <div className="w-8 h-8 rounded-full bg-bg2 border border-border flex items-center justify-center font-mono text-[10px] text-ink4 group-hover:text-red-noir transition-colors">
                                0{i + 1}
                              </div>
                              <div className="flex-1">
                                <span className="font-display text-[11px] text-ink tracking-[2px] uppercase block mb-1">{conn.object}</span>
                                <p className="font-serif text-[13px] text-ink3 leading-snug">
                                  The subject's reaction to this item was notably defensive.
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>

                  {/* Sidebar Stats */}
                  <aside className="space-y-8">
                    <div className="border border-border divide-y divide-border bg-bg2">
                      <div className="p-5">
                        <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">Age</div>
                        <div className="font-serif text-lg text-ink">{persona.age}</div>
                      </div>
                      <div className="p-5">
                        <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">Occupation</div>
                        <div className="font-serif text-lg text-ink leading-tight">{persona.occupation}</div>
                      </div>
                      <div className="p-5">
                        <div className="font-mono text-[8px] tracking-[3px] text-ink4 uppercase mb-2">Nervous Tells</div>
                        <div className="space-y-2 mt-2">
                          {persona.tells.map((tell, i) => (
                            <div key={i} className="flex items-center gap-2">
                              <div className="w-1 h-1 rounded-full bg-red-noir/40" />
                              <span className="font-serif text-sm text-ink2">{tell}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Action Button - Integrated into scroll or fixed? User usually wants it visible. */}
                    <div className="pt-4">
                      <button
                        onClick={() => setCurrentScreen('interrogation')}
                        className="group relative w-full font-display text-[10px] tracking-[5px] text-white uppercase bg-red-noir py-6 shadow-xl active:scale-95 transition-all overflow-hidden"
                      >
                        <span className="relative z-10">BEGIN INTERROGATION</span>
                        <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
                      </button>
                    </div>
                  </aside>
                </div>

                {/* Footer Spacer */}
                <div className="h-12" />
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
                <div className="w-8 h-8 rounded-full border border-redmute flex items-center justify-center text-sm overflow-hidden">
                  {persona.avatarUrl ? (
                    <img src={persona.avatarUrl} alt={persona.name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    "🕵️"
                  )}
                </div>
                <div>
                  <div className="font-mono text-[8px] tracking-[2px] text-red-noir uppercase">{persona.archetype}</div>
                  <div className="font-display text-sm tracking-widest text-ink">{persona.name}</div>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex flex-col items-end">
                  <div className="font-mono text-[7px] tracking-[2px] text-ink4 uppercase">Contradictions</div>
                  <div className="font-display text-xs text-red-noir">{contradictionCount}</div>
                </div>
                <div className={`font-mono text-xs tracking-[2px] ${timeLeft < 30 ? 'text-red-noir animate-pulse' : 'text-ink2'}`}>
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
                    onClick={() => msg.isContradiction && setSelectedContradiction(msg.contradictionQuote || null)}
                    className={`p-4 cursor-pointer transition-all ${
                      msg.role === 'user' 
                        ? 'bg-red-noir/10 border border-red-noir/30' 
                        : msg.isContradiction 
                          ? 'bg-amber-noir/10 border border-amber-noir shadow-[0_0_15px_rgba(224,168,32,0.2)]' 
                          : 'bg-surface border border-border'
                    }`}
                  >
                    <p className={`font-serif text-[15px] leading-relaxed ${msg.role === 'user' ? 'text-ink' : 'text-ink2'}`}>
                      {msg.text}
                    </p>
                    {msg.isContradiction && (
                      <div className="mt-2 font-mono text-[8px] text-amber-noir uppercase tracking-widest flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Contradiction Detected
                      </div>
                    )}
                  </div>
                  <div className={`mt-1 font-mono text-[7px] tracking-widest uppercase opacity-40 ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                    {msg.role === 'user' ? 'Detective' : persona.name}
                  </div>
                </motion.div>
              ))}
              {isInterrogating && (
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
              {/* Evidence Strip */}
              <div className="flex gap-2 mb-4 overflow-x-auto pb-2 no-scrollbar border-b border-border/30">
                {detections.map((obj, i) => (
                  <button
                    key={i}
                    onClick={() => setUserInput(`Tell me about the ${obj.label}`)}
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
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Ask the witness..."
                  className="w-full bg-bg border border-border px-4 py-3 font-serif text-sm text-ink placeholder:text-ink4 focus:outline-none focus:border-red-noir/50 transition-all"
                />
                <button
                  onClick={sendMessage}
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
                    <div className="font-mono text-[10px] tracking-[5px] text-amber-noir uppercase mb-4">Contradiction Caught</div>
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

        {currentScreen === 'accusation' && accusationOptions && (
          <motion.div
            key="accusation"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg overflow-y-auto p-6"
          >
            <div className="mb-12 text-center pt-12">
              <div className="font-mono text-[10px] tracking-[6px] text-red-noir uppercase mb-2">Final Verdict</div>
              <h2 className="font-display text-4xl text-ink tracking-widest">ACCUSATION</h2>
            </div>

            <div className="space-y-10 pb-24">
              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">1. The Suspect</div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.suspects.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedSuspect(s)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedSuspect === s ? 'bg-red-noir text-white border-red-noir' : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">2. The Method</div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.methods.map((m, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedMethod(m)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedMethod === m ? 'bg-red-noir text-white border-red-noir' : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-2">3. The Motive</div>
                <div className="grid grid-cols-1 gap-2">
                  {accusationOptions.motives.map((m, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedMotive(m)}
                      className={`p-4 text-left font-serif text-sm transition-all border ${
                        selectedMotive === m ? 'bg-red-noir text-white border-red-noir' : 'bg-surface text-ink border-border hover:border-red-noir/30'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </section>

              <button
                disabled={!selectedSuspect || !selectedMotive || !selectedMethod}
                onClick={handleSubmitVerdict}
                className="w-full font-display text-xs tracking-[5px] text-white uppercase bg-red-noir py-5 shadow-[0_0_25px_rgba(155,35,24,0.4)] active:scale-95 transition-all disabled:opacity-30 disabled:grayscale"
              >
                SUBMIT VERDICT
              </button>
            </div>
          </motion.div>
        )}

        {currentScreen === 'casefile' && verdict && (
          <motion.div
            key="casefile"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-10 flex flex-col bg-bg overflow-y-auto"
          >
            <div className="p-8 border-b-4 border-double border-border">
              <div className="flex justify-between items-start mb-8 pt-8">
                <div>
                  <div className="font-mono text-[10px] tracking-[4px] text-ink4 uppercase">Dossier #882-B</div>
                  <h2 className="font-display text-4xl text-ink tracking-tighter">CASE CLOSED</h2>
                  <div className="mt-2 font-mono text-[9px] tracking-[3px] text-red-noir uppercase">Lead: Det. {detectiveName}</div>
                </div>
                <div className={`px-4 py-2 border-2 font-display text-lg tracking-widest ${verdict.correct ? 'border-green-noir text-green-noir' : 'border-red-noir text-red-noir'} rotate-3`}>
                  {verdict.correct ? 'SOLVED' : 'UNSOLVED'}
                </div>
              </div>

              <div className="bg-surface p-6 border-l-4 border-ink mb-10">
                <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-2">Official Verdict</div>
                <p className="font-serif text-xl text-ink leading-tight mb-4">
                  {verdict.verdict}
                </p>
                <p className="font-serif text-sm text-ink2 italic">
                  {verdict.explanation}
                </p>
              </div>

              <div className="space-y-12 pb-24">
                <section>
                  <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-1">Timeline of Events</div>
                  <div className="space-y-4">
                    {timeline.map((event, i) => (
                      <div key={i} className="flex gap-4">
                        <div className="font-mono text-[10px] text-ink4 pt-1">0{i+1}</div>
                        <p className="font-serif text-sm text-ink leading-snug">{event}</p>
                      </div>
                    ))}
                  </div>
                </section>

                <section>
                  <div className="font-mono text-[9px] tracking-[3px] text-ink4 uppercase mb-4 border-b border-border pb-1">Interrogation Stats</div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="border border-border p-4">
                      <div className="font-mono text-[8px] text-ink4 uppercase">Contradictions Caught</div>
                      <div className="font-display text-2xl text-ink">{contradictionCount}</div>
                    </div>
                    <div className="border border-border p-4">
                      <div className="font-mono text-[8px] text-ink4 uppercase">Time Remaining</div>
                      <div className="font-display text-2xl text-ink">{formatTime(timeLeft)}</div>
                    </div>
                  </div>
                </section>

                <button
                  onClick={() => window.location.reload()}
                  className="w-full font-display text-xs tracking-[5px] text-white uppercase bg-ink py-5 active:scale-95 transition-all"
                >
                  NEW INVESTIGATION
                </button>
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
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-700 ${cameraStatus === 'live' ? 'opacity-100' : 'opacity-0'}`}
              />
              
              <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-cover hidden" />

              {/* CRT Overlays */}
              <div className="absolute inset-0 z-10 pointer-events-none bg-[repeating-linear-gradient(0deg,transparent,transparent_3px,rgba(0,0,0,0.03)_3px,rgba(0,0,0,0.03)_4px)]" />
              <div className="absolute left-0 right-0 h-1 z-10 pointer-events-none bg-gradient-to-b from-transparent via-greenbr/20 to-transparent animate-scandown" />
              <div className="absolute inset-0 z-10 pointer-events-none bg-radial from-transparent via-transparent to-ink/15" />

              {/* Corner Brackets */}
              <div className={`absolute top-4 left-4 w-6 h-6 z-20 border-t-2 border-l-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`} />
              <div className={`absolute top-4 right-4 w-6 h-6 z-20 border-t-2 border-r-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`} />
              <div className={`absolute bottom-4 left-4 w-6 h-6 z-20 border-b-2 border-l-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`} />
              <div className={`absolute bottom-4 right-4 w-6 h-6 z-20 border-b-2 border-r-2 ${isScanning ? 'border-amber-noir' : 'border-greenbr'} transition-colors`} />

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
                OBJECTS<span className="block text-[22px] font-display text-ink tracking-normal leading-none">{detections.length}</span>
              </div>

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
                      <span className={`font-mono text-[8px] tracking-tight ${obj.flagged ? 'text-amber-noir' : 'text-greenbr'} bg-surface/90 px-2 py-0.5 whitespace-nowrap border border-border/50`}>
                        {obj.label.toUpperCase()}
                      </span>
                      {obj.flagged && (
                        <span className="bg-amber-noir/20 text-amber-noir text-[8px] px-1 py-0.5">⚠</span>
                      )}
                    </div>
                  </motion.div>
                ))}
              </div>

              {/* Scanning Overlay */}
              {isScanning && (
                <div className="absolute inset-0 z-30 bg-bg/85 flex flex-col items-center justify-center gap-4">
                  <div className="w-12 h-12 border-2 border-greenbr/20 border-t-greenbr rounded-full animate-spin-slow" />
                  <div className="font-mono text-[10px] tracking-[4px] text-greenbr uppercase">Analysing scene…</div>
                  <p className="font-serif text-sm italic text-ink3 text-center px-12 leading-relaxed">
                    "I remember this room. Something happened here that I can't quite explain…"
                  </p>
                </div>
              )}
            </div>

            {/* Bottom Panel */}
            <div className="bg-surface border-t border-border px-6 pt-4 pb-24">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1.5 h-1.5 rounded-full bg-greenbr animate-breathe" />
                <span className="font-mono text-[10px] tracking-[3px] text-greenbr uppercase">
                  {isScanning ? 'Processing...' : detections.length > 0 ? 'Analysis Complete' : 'Ready to scan'}
                </span>
              </div>

              <div className="font-serif text-[clamp(14px,4vw,16px)] font-light italic text-ink2 leading-relaxed mb-4 pl-4 border-l-2 border-redmute min-h-[52px]">
                {isScanning ? (
                  '"Hold steady. I\'m trying to remember..." '
                ) : witnessQuote ? (
                  `"${witnessQuote}"`
                ) : detections.length > 0 ? (
                  '"I see it now. The details are coming back... Look at those items. They tell a story."'
                ) : (
                  '"Aim your camera at the scene. I\'ll tell you what I remember…"'
                )}
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

              {!showProceed && (
                <div className="flex items-center justify-center gap-6 py-2">
                  <div className="flex-1 text-center">
                    {isScanning && (
                      <motion.span 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="font-mono text-[8px] tracking-[3px] text-red-noir uppercase animate-pulse"
                      >
                        Scanning...
                      </motion.span>
                    )}
                  </div>
                  <button
                    onClick={captureScene}
                    className={`w-16 h-16 rounded-full border-4 border-ink2 flex items-center justify-center transition-all active:scale-90 relative ${isScanning ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    <div className={`absolute inset-1 rounded-full bg-ink transition-all ${isScanning ? 'bg-amber-noir animate-pulse' : ''}`} />
                  </button>
                  <div className="flex-1" />
                </div>
              )}

              {showProceed && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 flex gap-3"
                >
                  <button
                    onClick={handleRescan}
                    className="flex-1 font-display text-[10px] tracking-[3px] text-ink2 uppercase bg-surface border border-border py-4 active:scale-95 transition-all"
                  >
                    RESCAN
                  </button>
                  <button
                    onClick={handleMeetWitness}
                    className="flex-[2] font-display text-[10px] tracking-[3px] text-white uppercase bg-red-noir py-4 shadow-[0_0_18px_rgba(155,35,24,0.3)] active:scale-95 transition-all"
                  >
                    {isGeneratingPersona ? 'LOCATING...' : 'MEET THE WITNESS →'}
                  </button>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation & Utilities */}
      {['camera', 'witness', 'interrogation', 'accusation', 'casefile'].includes(currentScreen) && (
        <div className="fixed bottom-0 left-0 right-0 h-[84px] bg-bg/95 border-t border-border z-50 flex items-stretch pb-5">
          <button onClick={() => setCurrentScreen('camera')} className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'camera' ? 'border-red-noir' : 'border-transparent'}`}>
            <Camera className={`w-5 h-5 ${currentScreen === 'camera' ? 'text-red-noir' : 'text-ink4'}`} />
            <span className={`font-mono text-[9px] tracking-wider uppercase ${currentScreen === 'camera' ? 'text-red-noir' : 'text-ink4'}`}>Scene</span>
          </button>
          <button onClick={() => setCurrentScreen('witness')} className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'witness' ? 'border-red-noir' : 'border-transparent'}`}>
            <Eye className={`w-5 h-5 ${currentScreen === 'witness' ? 'text-red-noir' : 'text-ink4'}`} />
            <span className={`font-mono text-[9px] tracking-wider uppercase ${currentScreen === 'witness' ? 'text-red-noir' : 'text-ink4'}`}>Witness</span>
          </button>
          <button onClick={() => setCurrentScreen('interrogation')} className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'interrogation' ? 'border-red-noir' : 'border-transparent'}`}>
            <Mic className={`w-5 h-5 ${currentScreen === 'interrogation' ? 'text-red-noir' : 'text-ink4'}`} />
            <span className={`font-mono text-[9px] tracking-wider uppercase ${currentScreen === 'interrogation' ? 'text-red-noir' : 'text-ink4'}`}>Interrogate</span>
          </button>
          <button onClick={() => setCurrentScreen('accusation')} className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'accusation' ? 'border-red-noir' : 'border-transparent'}`}>
            <Scale className={`w-5 h-5 ${currentScreen === 'accusation' ? 'text-red-noir' : 'text-ink4'}`} />
            <span className={`font-mono text-[9px] tracking-wider uppercase ${currentScreen === 'accusation' ? 'text-red-noir' : 'text-ink4'}`}>Accuse</span>
          </button>
          <button onClick={() => setCurrentScreen('casefile')} className={`flex-1 flex flex-col items-center justify-center gap-1 border-t-2 transition-all ${currentScreen === 'casefile' ? 'border-red-noir' : 'border-transparent'}`}>
            <FileText className={`w-5 h-5 ${currentScreen === 'casefile' ? 'text-red-noir' : 'text-ink4'}`} />
            <span className={`font-mono text-[9px] tracking-wider uppercase ${currentScreen === 'casefile' ? 'text-red-noir' : 'text-ink4'}`}>Case File</span>
          </button>
        </div>
      )}

      {currentScreen !== 'splash' && (
        <button
          onClick={() => {
            if (currentScreen === 'onboarding') setCurrentScreen('splash');
            else if (currentScreen === 'camera') setCurrentScreen('onboarding');
            else setCurrentScreen('camera');
          }}
          className="fixed top-4 left-6 z-[60] flex items-center gap-2 bg-bg/85 border border-border px-3 py-2 backdrop-blur-md active:bg-surface2 transition-all"
        >
          <ChevronLeft className="w-3 h-3 text-ink2" />
          <span className="font-mono text-[8px] tracking-[3px] text-ink3 uppercase">Back</span>
        </button>
      )}

      <button
        onClick={toggleTheme}
        className={`fixed right-6 z-[60] w-11 h-11 rounded-full bg-surface2 border border-borderlt flex items-center justify-center text-lg shadow-lg active:scale-90 transition-all ${['camera', 'witness', 'interrogation', 'accusation', 'casefile'].includes(currentScreen) ? 'bottom-[100px]' : 'bottom-6'}`}
      >
        {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      {/* Global Camera Overlays */}
      <AnimatePresence>
        {currentScreen === 'camera' && cameraStatus === 'idle' && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-3/4 h-3/4 bg-bg border border-border p-8 flex flex-col items-center justify-center gap-8 text-center shadow-2xl"
            >
              <div className="relative">
                <Camera className="w-16 h-16 text-greenbr/40" />
                <div className="absolute inset-0 border border-greenbr/20 animate-ping rounded-full" />
              </div>
              <div className="space-y-4 max-w-md">
                <h3 className="font-display text-xl tracking-[5px] text-ink uppercase">Observation Required</h3>
                <p className="font-serif text-base italic text-ink3 leading-relaxed">
                  "The room is waiting. I need to see what you see to help you remember. Grant me access to your lens, detective."
                </p>
              </div>
              <button
                onClick={startCamera}
                className="group relative w-full max-w-xs font-display text-xs tracking-[5px] text-white uppercase bg-red-noir py-5 shadow-[0_15px_30px_rgba(155,35,24,0.3)] active:scale-95 transition-all overflow-hidden"
              >
                <span className="relative z-10">GRANT CAMERA PERMISSION</span>
                <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
              </button>
            </motion.div>
          </div>
        )}

        {currentScreen === 'camera' && cameraStatus === 'denied' && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 px-12 text-center bg-bg"
          >
            <Camera className="w-12 h-12 text-ink3" />
            <h3 className="font-display text-base tracking-[3px] text-ink uppercase">CAMERA ACCESS DENIED</h3>
            <p className="font-serif text-sm italic text-ink3 leading-relaxed">
              Enable camera access in your browser settings, then reload the page to begin your investigation.
            </p>
            <button
              onClick={startCamera}
              className="mt-4 font-display text-xs tracking-[3px] text-ink border border-border px-8 py-3 active:bg-surface2 transition-all"
            >
              TRY AGAIN
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
