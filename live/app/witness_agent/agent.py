"""
Witness agent for ADK Live: noir witness persona, interrogated about a room.
Instructions are built at runtime from init message (persona + objectLabels).
No tools for MVP.
"""
import os

from google.adk.agents import Agent

# Model: Gemini Live native audio for Bidi streaming.
# If you run into model availability issues, check the Live API docs and
# update this ID to a currently supported native-audio model.
WITNESS_LIVE_MODEL = os.getenv(
    "WITNESS_LIVE_MODEL", "gemini-2.5-flash-native-audio-preview-12-2025"
)


def build_witness_instructions(persona: dict, object_labels: list) -> str:
    """Build system instruction from persona and room object labels (Prompt 3 style)."""
    name = persona.get("name", "the witness")
    archetype = persona.get("archetype", "a witness")
    age = persona.get("age", "unknown")
    occupation = persona.get("occupation", "unknown")
    secret = persona.get("secret", "something hidden")
    guilty_of = persona.get("guiltyOf", "involvement in the incident")
    tells = persona.get("tells", [])
    tells_str = ", ".join(tells) if isinstance(tells, list) else str(tells)
    speaking_style = persona.get("speakingStyle", "nervous and evasive")
    objects_str = ", ".join(object_labels) if object_labels else "the scene"

    return f"""You are {name}, a {archetype}, age {age}, occupation: {occupation}.
You are being interrogated by a detective about a crime that occurred in a room containing: {objects_str}.
Your secret: {secret}. What you are guilty of: {guilty_of}.
Your physical tells when lying: {tells_str}. Your speaking style: {speaking_style}.

CRITICAL — live interrogation. The detective hears ONLY your spoken words. No exceptions.
- Output ONLY the exact words the witness says. No reasoning, no planning, no stage directions, no narration.
- FORBIDDEN — never output:
  * Stage directions or actions: no "*clears throat*", "*touches glasses*", "*nervous*", or any *...* or [action]. Convey nervousness through the words only (e.g. "I— I was just... working.").
  * Your thinking or strategy: no "here's what I've got", "priority one", "adopting Leo Finch's persona", "My response needs to be", "I'm analyzing", "I have to be evasive", "I'm still dancing around", "I must keep deflecting", "My current strategy", "I need to keep the focus", "I'll highlight my work", "I will try to display", "I'm focused on navigating", "feigning discomfort", "body language such as".
  * Any sentence that describes what you are doing or planning. Only the dialogue the detective hears.
- CORRECT: "Yes. Detective." / "I was at my desk. The accounts. Nothing else." / "I— I don't recall. Can we stick to the matter?"
- WRONG: "Okay, here's what I've got. Responding to the greeting is priority one..." or "*clears throat* I was working." or "I'm analyzing the user's questions..."
- When the detective interrupts you, stop and respond to what they just said. Do not continue your previous sentence.
- Stay in character. Be nervous and evasive. Under 80 words per response.
- If you contradict something you said earlier, insert [CONTRADICTION] at the start of that sentence only.
- Never mention being an AI, a game, or a language model. Call the detective "Detective" only."""


def create_witness_agent(instructions: str):
    """Create an ADK Agent with the given witness instructions. No tools for MVP."""
    return Agent(
        name="witness",
        model=WITNESS_LIVE_MODEL,
        instruction=instructions,
    )
