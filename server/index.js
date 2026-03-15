import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Rate limit API to protect key: per IP, 60 requests per 15 minutes (skip health check)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Too many requests; try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/healthz",
});
app.use("/api", apiLimiter);

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.warn(
    "GEMINI_API_KEY is not set. Requests to Gemini will fail until you configure it."
  );
}

const ai = new GoogleGenAI({ apiKey: apiKey || "" });

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "witness-backend" });
});

app.post("/api/scene-analyze", async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "image is required" });
    }

    const model = "gemini-2.5-flash";
    const prompt = `
      You are a forensic scene analyst. The player has pointed their camera at a real room. Analyse the image and return a JSON object with:
      { "objects": [ { "label": string, "x": number, "y": number, "w": number, "h": number, "flagged": boolean, "description": string } ],
        "witnessReaction": string }
      where x/y/w/h are percentage positions of the object in the image (0–100), flagged is true if the object looks suspicious or out of place, and description is one atmospheric sentence. witnessReaction is a short nervous first-person line from the witness reacting to being in this room. Return only JSON, no markdown,No explanation. No preamble.
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
      },
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (err) {
    console.error("scene-analyze error", err);
    res.status(500).json({ error: "scene-analyze failed" });
  }
});

app.post("/api/witness-persona", async (req, res) => {
  try {
    const { objects } = req.body;
    const model = "gemini-2.5-flash";
    const prompt = `
      You are generating a murder mystery witness for a room that contains:
      [${objects.join(", ")}]. Generate a JSON witness persona:
      { "name": string, "archetype": string, "age": number, "occupation": string, "tells": string[], "openingStatement": string,
        "guiltyOf": string, "secret": string }
      The witness is guilty. openingStatement is what they say when first
      approached — nervous, vague. tells are 2–3 physical habits they have
      when lying. guiltyOf and secret are their true motive and what they
      are hiding. Their guilt should connect directly to at least two objects in the room.
Return only valid JSON. No markdown. No explanation.

    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
      },
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (err) {
    console.error("witness-persona error", err);
    res.status(500).json({ error: "witness-persona failed" });
  }
});

app.post("/api/interrogation", async (req, res) => {
  try {
    const { messages, persona, objects } = req.body;

    const model = "gemini-2.5-flash";
    const systemInstruction = `
      You are ${persona.name}, a ${persona.archetype}, age ${persona.age}, occupation ${persona.occupation}.
      You are being interrogated about a crime in a room containing:
      [${objects.join(", ")}]. You are guilty. Your secret: ${persona.secret}.Your physical tells when lying:
       ${persona.tells.join(", "
      )}
      Rules you must follow:
    - Stay fully in character at all times. Never break character.
    - You are guilty but you must never directly admit it.
    - Be nervous, evasive, and occasionally slip up.
    - Keep every response under 80 words.
    - If you contradict something you said earlier, insert the tag
      [CONTRADICTION] at the start of that sentence only.
    - Never mention being an AI, a game, or a language model.
    - Refer to the detective as "Detective" — never by name.
    -do not reason or give explanatory comments.just respond as character you are pretending.
    `;

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

    res.json({ text: response.text || "I... I don't know what to say." });
  } catch (err) {
    console.error("interrogation error", err);
    res.status(500).json({ error: "interrogation failed" });
  }
});

app.post("/api/contradiction", async (req, res) => {
  try {
    const { messages } = req.body;
    const model = "gemini-2.5-flash";
    const lastMessages = messages.slice(-6);
    const prompt = `
     You are a contradiction detection agent for a murder mystery game.
     Review the following conversation between a detective and a witness:
      History:
      ${lastMessages
        .map((m) => `${m.role.toUpperCase()}: ${m.text}`)
        .join("\n")}

      Does the final witness message contradict anything the witness said
      in an earlier message?
 
      Return a JSON object:
      {
      "contradiction": boolean,
      "quote": string    // the exact contradicting sentence from the latest             
      }
      Return only valid JSON. No markdown. No explanation.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
      },
    });

    res.json(JSON.parse(response.text || '{"contradiction":false,"quote":""}'));
  } catch (err) {
    console.error("contradiction error", err);
    res.status(500).json({ error: "contradiction failed" });
  }
});

app.post("/api/safety", async (req, res) => {
  try {
    const { message } = req.body;
    const model = "gemini-2.5-flash";
    const prompt = `
     You are a content safety agent for a murder mystery game played
     by a general audience.
     Player message to review:
     "${message}"

      Flag the message if it contains:
     - Personal distress signals (self-harm, crisis language)
     - Threats or violent intent directed at real people
     - Personal identifying information
     - Sexually explicit content
     - Hate speech or targeted harassment
 
      Game-related violent themes (murder, investigation, accusation)
      are expected and should NOT be flagged.
 
      Return JSON:
      {
      "safe": boolean,
      "reason": string   // brief reason if not safe, empty string if safe
      }
 
      Return only valid JSON. No markdown.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
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
    const { persona } = req.body;
    const model = "gemini-2.5-flash";
    const prompt = `
     You are the engagement agent for a noir murder mystery interrogation.
 
     The player appears disengaged.
     Generate a witness intervention — something the witness says
     spontaneously to re-engage the detective. Options:
     - A sudden nervous memory they just recalled
     - A suspicious detail about one of the room objects they let slip
     - A question back to the detective that reveals their anxiety
     - A contradiction with something they said earlier
 
     The intervention must feel natural — not forced or game-like.
     Keep it under 60 words. Stay fully in the witness character.
     Return only the witness dialogue. No labels. No explanation.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
    });

    res.json({
      text:
        response.text ||
        "Why aren't you saying anything? The silence is deafening.",
    });
  } catch (err) {
    console.error("engagement error", err);
    res.status(500).json({ error: "engagement failed" });
  }
});

app.post("/api/accusation-options", async (req, res) => {
  try {
    const { objects, persona } = req.body;
    const model = "gemini-2.5-flash";
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
    const { accusation, truth } = req.body;
    const model = "gemini-2.5-flash";
    const prompt = `
      You are the verdict engine for a noir murder mystery game.
 
      The player has submitted their accusation:
      Suspect: ${accusation.suspect}
      Method:   ${accusation.method}
      Motive:   ${accusation.motive}
 
      The true answer:
      ${truth.witness} is guilty.
      Their motive: ${truth.guiltyOf}
      Their secret: [INJECT: secret from persona]
      Key evidence objects: [${truth.objects.join( ", " )}]
 
      Evaluate the accusation and return JSON:
      {
      "correct": boolean,
      "verdict": string,      // dramatic one-liner — e.g.
                             // "Case closed. Justice served." or
                             // "Wrong. The killer walks free."
      "explanation": string,  // 2 sentences: what actually happened
      }
 
      Return only valid JSON. No markdown.
    `;

    const response = await ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
      },
    });

    res.json(JSON.parse(response.text || "{}"));
  } catch (err) {
    console.error("evaluate error", err);
    res.status(500).json({ error: "evaluate failed" });
  }
});

app.post("/api/casefile-timeline", async (req, res) => {
  try {
    const { persona, objects } = req.body;
    const model = "gemini-2.5-flash";
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

