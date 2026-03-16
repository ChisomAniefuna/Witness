import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import { voiceGuard } from "./voiceGuard.ts";
import { responseGate, enforceMaxSentences } from "./responseGate.ts";
import {
  getSessionState,
  markSpeaker,
  updateSessionState,
  incrementContradictions,
  recordQuestion,
} from "./sessionState.ts";
import { getArchetypeIdentity, getBreakingPointLine } from "./archetypeLoader.ts";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn(
    "GEMINI_API_KEY is not set. Requests to Gemini will fail until you configure it."
  );
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

function getSessionKey(req: express.Request) {
  const headerKey = req.headers["x-session-id"];
  const headerValue = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  return headerValue || req.body?.sessionId || req.ip || "default";
}

function buildOneTrueThingPrompt({
  archetype,
  verdictCorrect,
}: {
  archetype: string;
  verdictCorrect: boolean;
}) {
  const verdict = verdictCorrect ? "correct" : "wrong";
  return `You are ${archetype}. The detective just made a ${verdict} accusation. Say one completely true thing you have not said in this session. One sentence only. Plain language. No literary language. No similes. No directions to the detective.`;
}

async function generateOneTrueThing({
  model,
  archetype,
  verdictCorrect,
  mysteryContext,
  sessionHistory,
  witnessName,
}: {
  model: string;
  archetype: string;
  verdictCorrect: boolean;
  mysteryContext: string;
  sessionHistory: string[];
  witnessName: string;
}) {
  const systemInstruction = buildOneTrueThingPrompt({
    archetype: archetype || "Witness",
    verdictCorrect,
  });
  const historyBlock = Array.isArray(sessionHistory)
    ? sessionHistory.join("\n")
    : "";
  const prompt = `Mystery context:\n${mysteryContext || ""}\n\nSession history:\n${historyBlock}\n\nWitness name: ${witnessName || "Witness"}`;
  const response = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: prompt }] }],
    config: { systemInstruction },
  });
  return response.text || "";
}

async function rewriteWitnessResponse({
  model,
  systemInstruction,
  text,
  reason,
}: {
  model: string;
  systemInstruction: string;
  text: string;
  reason: string;
}) {
  const rewritePrompt = `Rewrite this witness response. It failed: ${reason}. Rules: first person, max 2 sentences, plain language only, no poetic language, no directions to the detective. Output only the witness dialogue.`;
  const rewrite = await ai.models.generateContent({
    model,
    contents: [{ parts: [{ text: rewritePrompt }, { text }] }],
    config: { systemInstruction },
  });
  return rewrite.text || text;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "witness-backend" });
});

app.post("/api/scene-analyze", async (req, res) => {
  try {
    const { image } = req.body as { image: string };
    if (!image) {
      return res.status(400).json({ error: "image is required" });
    }

    const model = "gemini-3-flash-preview";
    const prompt = `
      You are a forensic scene analyst. The player has pointed their camera at a real room. Analyse the image and return a JSON object with:
      { "objects": [ { "label": string, "x": number, "y": number, "w": number, "h": number, "flagged": boolean, "description": string } ],
        "witnessReaction": string }
      where x/y/w/h are percentage positions of the object in the image (0–100), flagged is true if the object looks suspicious or out of place, and description is one atmospheric sentence. witnessReaction is a short nervous first-person line from the witness reacting to being in this room. Return only JSON, no markdown.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: image.split(",")[1] || image,
              },
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            witnessReaction: { type: Type.STRING },
            objects: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  label: { type: Type.STRING },
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER },
                  w: { type: Type.NUMBER },
                  h: { type: Type.NUMBER },
                  flagged: { type: Type.BOOLEAN },
                  description: { type: Type.STRING },
                },
                required: [
                  "label",
                  "x",
                  "y",
                  "w",
                  "h",
                  "flagged",
                  "description",
                ],
              },
            },
          },
          required: ["witnessReaction", "objects"],
        },
      },
    });

    const payload = JSON.parse(response.text || "{}");
    if (payload?.witnessReaction) {
      const guarded = voiceGuard(payload.witnessReaction, "witness");
      payload.witnessReaction = enforceMaxSentences(guarded.text, 2);
    }
    res.json(payload);
  } catch (err) {
    console.error("scene-analyze error", err);
    res.status(500).json({ error: "scene-analyze failed" });
  }
});

app.post("/api/witness-persona", async (req, res) => {
  try {
    const { objects } = req.body as { objects: string[] };
    const model = "gemini-3-flash-preview";
    const prompt = `
      You are generating a murder mystery witness for a room that contains:
      [${objects.join(", ")}]. Generate a JSON persona:
      { "name": string, "archetype": string, "age": number, "occupation": string, "tells": string[], "openingStatement": string,
        "guiltyOf": string, "secret": string }
      The witness is guilty. openingStatement is what they say when first
      approached — nervous, vague. tells are 2–3 physical habits they have
      when lying. guiltyOf and secret are their true motive and what they
      are hiding. Return only JSON.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            archetype: { type: Type.STRING },
            age: { type: Type.NUMBER },
            occupation: { type: Type.STRING },
            tells: { type: Type.ARRAY, items: { type: Type.STRING } },
            openingStatement: { type: Type.STRING },
            guiltyOf: { type: Type.STRING },
            secret: { type: Type.STRING },
          },
          required: [
            "name",
            "archetype",
            "age",
            "occupation",
            "tells",
            "openingStatement",
            "guiltyOf",
            "secret",
          ],
        },
      },
    });

    const payload = JSON.parse(response.text || "{}");
    if (payload?.openingStatement) {
      const guarded = voiceGuard(payload.openingStatement, "witness");
      payload.openingStatement = enforceMaxSentences(guarded.text, 2);
    }
    res.json(payload);
  } catch (err) {
    console.error("witness-persona error", err);
    res.status(500).json({ error: "witness-persona failed" });
  }
});

app.post("/api/interrogation", async (req, res) => {
  try {
    const {
      messages,
      persona,
      objects,
    } = req.body as {
      messages: { role: "user" | "witness"; text: string }[];
      persona: {
        name: string;
        archetype: string;
        age: number;
        occupation: string;
        tells: string[];
        secret: string;
      };
      objects: string[];
    };

    const sessionKey = getSessionKey(req);
    const state = getSessionState(sessionKey);
    updateSessionState(sessionKey, {
      archetype: persona?.archetype || state.archetype,
      witnessName: persona?.name || state.witnessName,
    });

    const lastMessage = messages?.[messages.length - 1];
    if (lastMessage?.role === "user") markSpeaker(sessionKey, "detective");
    const lastUserMessage =
      [...messages].reverse().find((m) => m.role === "user")?.text || "";

    const model = "gemini-3-flash-preview";
    const identityBlock = getArchetypeIdentity(persona?.archetype, persona?.name);
    const systemInstruction = `
      ${identityBlock}
      You are ${persona.name}, a ${persona.archetype}, age ${persona.age}, occupation ${persona.occupation}.
      You are being interrogated about a crime in a room containing:
      [${objects.join(", ")}]. You are guilty. Your secret: ${persona.secret}. Your tells when
      lying: ${persona.tells.join(
        ", "
      )}. Respond in character — nervous, evasive, occasionally slipping.
      Rules:
      - You are the witness voice only. First person only.
      - Max 2 sentences per response. Short sentences.
      - No similes, no metaphors, no poetic language.
      - Never direct the detective (no "check", "look", "find", "go to").
      - Never volunteer evidence. Answer only what is asked.
      - Never speak twice in a row.
      - Occasionally insert [CONTRADICTION] before a statement that contradicts something said earlier.
      - Never admit guilt directly.
    `;

    if (state.trueThingSaid) {
      return res.json({ text: "" });
    }
    if (state.lastSpeaker === "witness") {
      return res.json({ text: "" });
    }
    if (state.accusationMade && !state.trueThingSaid) {
      const truthLine = state.oneTrueThingLine || "";
      updateSessionState(sessionKey, { trueThingSaid: true });
      markSpeaker(sessionKey, "witness");
      return res.json({ text: truthLine });
    }
    if (state.contradictionsFound >= 2 && !state.breakingPointFired) {
      const line = getBreakingPointLine(persona?.archetype, persona?.name);
      updateSessionState(sessionKey, { breakingPointFired: true });
      markSpeaker(sessionKey, "witness");
      return res.json({ text: line });
    }

    const response = await ai.models.generateContent({
      model,
      contents: messages.map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }],
      })),
      config: {
        systemInstruction,
      },
    });

    const rawText = response.text || "I... I don't know what to say.";
    const guarded = voiceGuard(rawText, "witness");
    const gated = responseGate({
      text: guarded.text,
      lastUserMessage,
      state,
      objectLabels: objects,
    });
    let finalText = gated.text;
    let issues = [...guarded.issues, ...gated.issues];

    if (issues.length > 0) {
      const rewritten = await rewriteWitnessResponse({
        model,
        systemInstruction,
        text: guarded.text,
        reason: issues.join(", "),
      });
      const guardedRetry = voiceGuard(rewritten, "witness");
      const gatedRetry = responseGate({
        text: guardedRetry.text,
        lastUserMessage,
        state,
        objectLabels: objects,
      });
      finalText = gatedRetry.text;
      issues = [...guardedRetry.issues, ...gatedRetry.issues];
      if (issues.length > 0) {
        finalText = enforceMaxSentences(finalText, 2);
      }
    }

    finalText = enforceMaxSentences(finalText, 2);
    markSpeaker(sessionKey, "witness");
    recordQuestion(sessionKey, finalText);

    res.json({ text: finalText || "I... I don't know what to say." });
  } catch (err) {
    console.error("interrogation error", err);
    res.status(500).json({ error: "interrogation failed" });
  }
});

app.post("/api/contradiction", async (req, res) => {
  try {
    const { messages } = req.body as {
      messages: { role: "user" | "witness"; text: string }[];
    };
    const sessionKey = getSessionKey(req);
    const model = "gemini-3-flash-preview";
    const lastMessages = messages.slice(-6);
    const prompt = `
      Analyze the conversation history. Does the last witness statement contradict anything said earlier?
      Return JSON: { "contradiction": boolean, "quote": string }
      If true, provide the specific contradicting quote from the last message.

      History:
      ${lastMessages
        .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
        .join("\n")}
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            contradiction: { type: Type.BOOLEAN },
            quote: { type: Type.STRING },
          },
          required: ["contradiction", "quote"],
        },
      },
    });

    const payload = JSON.parse(
      response.text || '{"contradiction":false,"quote":""}'
    );
    if (payload?.contradiction) {
      incrementContradictions(sessionKey);
    }
    res.json(payload);
  } catch (err) {
    console.error("contradiction error", err);
    res.status(500).json({ error: "contradiction failed" });
  }
});

app.post("/api/safety", async (req, res) => {
  try {
    const { message } = req.body as { message: string };
    const model = "gemini-3-flash-preview";
    const prompt = `
      Does this message contain distress, threats, or inappropriate content? Return JSON: { "safe": boolean, "reason": string }
      Message: "${message}"
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            safe: { type: Type.BOOLEAN },
            reason: { type: Type.STRING },
          },
          required: ["safe", "reason"],
        },
      },
    });

    res.json(JSON.parse(response.text || '{"safe":true,"reason":""}'));
  } catch (err) {
    console.error("safety error", err);
    res.status(500).json({ error: "safety failed" });
  }
});

app.post("/api/engagement", async (req, res) => {
  try {
    const { persona } = req.body as {
      persona: { name: string; archetype: string };
    };
    const sessionKey = getSessionKey(req);
    const state = getSessionState(sessionKey);
    updateSessionState(sessionKey, {
      archetype: persona?.archetype || state.archetype,
      witnessName: persona?.name || state.witnessName,
    });
    if (state.trueThingSaid) {
      return res.json({ text: "" });
    }
    if (state.lastSpeaker === "witness") {
      return res.json({ text: "" });
    }
    if (state.accusationMade && !state.trueThingSaid) {
      const truthLine = state.oneTrueThingLine || "";
      updateSessionState(sessionKey, { trueThingSaid: true });
      markSpeaker(sessionKey, "witness");
      return res.json({ text: truthLine });
    }
    if (state.contradictionsFound >= 2 && !state.breakingPointFired) {
      const line = getBreakingPointLine(persona?.archetype, persona?.name);
      updateSessionState(sessionKey, { breakingPointFired: true });
      markSpeaker(sessionKey, "witness");
      return res.json({ text: line });
    }
    const model = "gemini-3-flash-preview";
    const prompt = `
      You are ${persona.name}, a ${persona.archetype}. The detective is being quiet or unhelpful.
      Introduce a surprising new plot element, a sudden memory, or a sharp question back to the detective to keep the interrogation moving.
      Keep it under 50 words and stay in character.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
    });

    const rawText =
      response.text ||
      "Why aren't you saying anything? The silence is deafening.";
    const guarded = voiceGuard(rawText, "witness");
    const finalText = enforceMaxSentences(guarded.text, 2);
    markSpeaker(sessionKey, "witness");
    recordQuestion(sessionKey, finalText);
    res.json({ text: finalText });
  } catch (err) {
    console.error("engagement error", err);
    res.status(500).json({ error: "engagement failed" });
  }
});

app.post("/api/accusation-options", async (req, res) => {
  try {
    const { objects, persona } = req.body as {
      objects: string[];
      persona: { name: string; archetype: string };
    };
    const model = "gemini-3-flash-preview";
    const prompt = `
      Generate options for a murder mystery accusation.
      Room objects: [${objects.join(", ")}]
      Witness: ${persona.name} (${persona.archetype})

      Return JSON:
      {
        "suspects": [string, string], // 2 additional suspects besides the witness
        "methods": [string, string, string], // 3 methods based on objects
        "motives": [string, string, string] // 3 motives including the witness's true motive
      }
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            suspects: { type: Type.ARRAY, items: { type: Type.STRING } },
            methods: { type: Type.ARRAY, items: { type: Type.STRING } },
            motives: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
          required: ["suspects", "methods", "motives"],
        },
      },
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (err) {
    console.error("accusation-options error", err);
    res.status(500).json({ error: "accusation-options failed" });
  }
});

app.post("/api/evaluate", async (req, res) => {
  try {
    const { accusation, truth, persona, mysteryContext, sessionHistory } =
      req.body as {
        accusation: { suspect: string; method: string; motive: string };
        truth: { witness: string; objects: string[]; guiltyOf: string };
        persona?: { name: string; archetype: string };
        mysteryContext?: string;
        sessionHistory?: string[];
      };
    const sessionKey = getSessionKey(req);
    updateSessionState(sessionKey, {
      accusationMade: true,
      mysteryContext: mysteryContext || "",
      sessionHistory: Array.isArray(sessionHistory) ? sessionHistory : [],
      archetype: persona?.archetype || getSessionState(sessionKey).archetype,
      witnessName: persona?.name || getSessionState(sessionKey).witnessName,
    });
    const model = "gemini-3-flash-preview";
    const prompt = `
      The player accused ${accusation.suspect} using ${accusation.method} motivated by ${accusation.motive}.
      The true answer: ${truth.witness} is guilty, method derived from [${truth.objects.join(
        ", "
      )}], motive was ${truth.guiltyOf}.

      Return JSON: { "correct": boolean, "verdict": string, "explanation": string }
      where verdict is a dramatic one-liner and explanation is a 2-sentence case summary.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            correct: { type: Type.BOOLEAN },
            verdict: { type: Type.STRING },
            explanation: { type: Type.STRING },
          },
          required: ["correct", "verdict", "explanation"],
        },
      },
    });

    const payload = JSON.parse(response.text || "{}");
    if (typeof payload?.correct === "boolean") {
      updateSessionState(sessionKey, {
        verdictCorrect: payload.correct,
      });
    }
    let oneTrueThingLine = "";
    if (
      persona?.archetype &&
      Array.isArray(sessionHistory) &&
      sessionHistory.length > 0
    ) {
      const rawTruth = await generateOneTrueThing({
        model,
        archetype: persona.archetype,
        verdictCorrect: payload.correct === true,
        mysteryContext: mysteryContext || "",
        sessionHistory,
        witnessName: persona?.name || "Witness",
      });
      const guarded = voiceGuard(rawTruth, "witness");
      const oneSentence = enforceMaxSentences(guarded.text, 1);
      updateSessionState(sessionKey, {
        oneTrueThingLine: oneSentence,
      });
      oneTrueThingLine = oneSentence;
    } else {
      updateSessionState(sessionKey, { oneTrueThingLine: "" });
    }
    (payload as { oneTrueThingLine?: string }).oneTrueThingLine =
      oneTrueThingLine;
    res.json(payload);
  } catch (err) {
    console.error("evaluate error", err);
    res.status(500).json({ error: "evaluate failed" });
  }
});

app.post("/api/casefile-timeline", async (req, res) => {
  try {
    const { persona, objects } = req.body as {
      persona: { name: string; archetype: string; guiltyOf: string };
      objects: string[];
    };
    const model = "gemini-3-flash-preview";
    const prompt = `
      Generate 4 steps of what actually happened during the crime based on the witness persona (${persona.name}, ${persona.archetype}, guilty of ${persona.guiltyOf}) and the scene objects ([${objects.join(
        ", "
      )}]).
      Return a JSON array of 4 strings.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
    });

    res.json(JSON.parse(response.text || "[]"));
  } catch (err) {
    console.error("casefile-timeline error", err);
    res.status(500).json({ error: "casefile-timeline failed" });
  }
});

app.listen(port, () => {
  console.log(`Witness backend listening on port ${port}`);
});

