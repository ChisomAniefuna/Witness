from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field


class SceneObject(BaseModel):
    label: str
    x: float
    y: float
    w: float
    h: float
    flagged: bool
    description: str


class ScanResponse(BaseModel):
    objects: List[SceneObject]
    witnessReaction: str


class WitnessPersona(BaseModel):
    name: str
    archetype: str
    age: int
    occupation: str
    tells: List[str]
    openingStatement: str
    guiltyOf: str
    secret: str
    speakingStyle: str


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "model"]
    content: str


class Accusation(BaseModel):
    suspect: str
    method: str
    motive: str


class Verdict(BaseModel):
    correct: bool
    verdict: str
    explanation: str
    score: int


class Annotation(BaseModel):
    turn: int
    text: str
    verdict: Literal["lie", "truth", "partial"]
    note: str


class TimelineStep(BaseModel):
    step: int
    time: str
    event: str


class CaseFile(BaseModel):
    annotations: List[Annotation]
    timeline: List[TimelineStep]


class State(BaseModel):
    sceneObjects: List[SceneObject] = Field(default_factory=list)
    witnessPersona: Optional[WitnessPersona] = None
    conversationHistory: List[ChatMessage] = Field(default_factory=list)
    contradictions: List[dict] = Field(default_factory=list)
    flaggedSafe: bool = True
    accusation: Optional[Accusation] = None
    verdict: Optional[Verdict] = None
    caseFile: Optional[CaseFile] = None
