<div align="center">
  <img width="1200" height="475" alt="Witness Banner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

## Witness

**Every Room Tells A Story. Every Object Hides A Clue.**  
Witness is a noir murder‑mystery experience for the Gemini Live Agent Challenge.  
You point your camera at a real room; Gemini turns it into a crime scene and becomes the only witness you can interrogate.

---

### In a nutshell

- **Scan any real room** – The camera feed is analysed by Gemini; objects become evidence (mug, window, chair, ceiling fan…) with bounding boxes and atmospheric descriptions.
- **Meet the AI witness** – Gemini generates a persona (name, archetype, age, occupation, nervous tells, opening statement, motive, secret) grounded in that specific room.
- **Interrogate in real time** – You question the witness about objects and events. They lie, evade, and contradict themselves; an agent flags contradictions in the UI.
- **Make your accusation** – Choose suspect, method, and motive from options tied to the scene. Gemini evaluates how close you are to the truth.
- **Receive a case file** – A generated dossier explains what really happened, plus a timeline and interrogation stats.

---

### Why this project

The Gemini Live Agent Challenge asks builders to break the text‑box paradigm.  
Witness does this by turning **your physical space** into the game board:

- Vision: the room scan is not a background – it *is* the mystery.
- Language: the witness persona and interrogation are fully AI‑driven.
- Agents: engagement, contradiction detection, and safety logic keep the story tense and playable.

Our goal is an experience that feels more like stepping into a crime scene than “using an app”.

---

### Architecture

**Frontend** (`/src`)

- `App.tsx` – Single‑page React app (Vite + TypeScript) with the full flow:
  - Splash → onboarding → camera/scene → witness → interrogation → accusation → case file.
  - Camera via `getUserMedia`, HUD overlays, and animated noir UI.
- `services/geminiService.ts` – Thin client talking to the backend HTTP API.
- Styling – Tailwind v4 with custom noir palette and motion (`motion` library) for transitions.

**Backend** (`/server`)

- `index.js` – Node + Express API wrapping the Google GenAI SDK (`@google/genai`):
  - `POST /api/scene-analyze` – image → JSON objects + witness reaction (Gemini `gemini-2.5-flash`).
  - `POST /api/witness-persona` – room objects → persona JSON.
  - `POST /api/interrogation` – conversation history + persona → witness reply.
  - `POST /api/contradiction` – recent history → `{ contradiction, quote }`.
  - `POST /api/safety` – user text → `{ safe, reason }`.
  - `POST /api/engagement` – re‑engagement line if the detective goes quiet.
  - `POST /api/accusation-options` – suspects, methods, motives for the final accusation.
  - `POST /api/evaluate` – accusation vs. ground truth → verdict + explanation.
  - `POST /api/casefile-timeline` – 4‑step narrative of what actually happened.

Environment:

- `GEMINI_API_KEY` is read from `.env` on the backend.
- `VITE_API_BASE_URL` (in `.env.local`) points the frontend at the backend (local or Cloud Run).

---

### Getting started (local)

**Prerequisites**

- Node.js 20+ (we develop with the latest LTS)
- A Gemini API key from Google AI Studio

**1. Clone and install**

```bash
git clone https://github.com/YOUR_ORG/witness.git
cd witness
npm install
```

**2. Configure environment**

Backend (`.env` in project root):

```bash
GEMINI_API_KEY=your_real_key_here
```

Frontend (`.env.local` in project root):

```bash
VITE_API_BASE_URL="http://localhost:8080"
```

**3. Run backend and frontend**

In one terminal:

```bash
npm run server
```

In another terminal:

```bash
npm run dev
```

Open `http://localhost:3000` and play through:

1. Splash → **Begin Investigation** → **Enter the Scene**.  
2. Point the camera at a real room, tap the shutter, wait for analysis + bounding boxes.  
3. Tap **MEET THE WITNESS →**, read the persona, then **BEGIN INTERROGATION**.  
4. Ask about objects, catch contradictions, then **MAKE ACCUSATION** and submit a verdict.  
5. Review the generated case file.

---

### Deploying to Google Cloud Run (backend)

The repo includes a minimal deployment pipeline:

- `Dockerfile` – builds a Node image for the Express backend.
- `cloudbuild.yaml` – builds, pushes, and deploys `witness-backend` to Cloud Run.

Basic flow:

```bash
gcloud builds submit --config=cloudbuild.yaml .
```

Then in Cloud Run:

- Set `GEMINI_API_KEY` as an environment variable.
- Copy the service URL and use it as `VITE_API_BASE_URL` for your deployed frontend.

---

### Repo structure

- `src/` – React app (UI, flows, animations).
- `src/services/geminiService.ts` – frontend API client for the backend.
- `server/index.js` – Express backend + Gemini GenAI calls.
- `resources/` – PRD, team brief, Devpost draft, and build task checklist (not committed in git).
- `cloudbuild.yaml` – Cloud Build pipeline for Cloud Run backend.
- `Dockerfile` – Backend container image.

---

### Hackathon notes

This project is being built for the **Gemini Live Agent Challenge** in the **Creative Storyteller** / **Live Agent** tracks.  
There is an up‑to‑date checklist of remaining work in `resources/BUILD_TASKS.md` (Live audio, richer case file output, ADK‑style agent orchestration, and final Cloud Run deployment + demo video). !*** End Patch```}>>();
