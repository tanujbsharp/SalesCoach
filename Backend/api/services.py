import json
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set
from uuid import uuid4

from django.conf import settings

from document import extract_text
from tts import generate_tts

DocumentRecord = Dict[str, Any]

BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = settings.MEDIA_ROOT

document_path = BASE_DIR / "knowledge" / "EchoDot.pptx"

DOCUMENT_STORE: Dict[str, DocumentRecord] = {}
QUIZ_STORE: Dict[str, Dict[str, Any]] = {}
DEFAULT_DOCUMENT_ID = "default"


class TopicIrrelevantError(Exception):
    """Raised when a user requests a topic that the document does not cover."""


def _extract_keywords(value: Optional[str]) -> List[str]:
    if not value:
        return []
    return [
        token
        for token in re.findall(r"[A-Za-z0-9']+", value.lower())
        if len(token) >= 3
    ]


def _tokenize_text(value: str) -> List[str]:
    return [token for token in re.findall(r"[A-Za-z0-9']+", value.lower()) if token]


def _fuzzy_token_match(tokens: Sequence[str], doc_tokens: Sequence[str], threshold: float = 0.78) -> bool:
    if not tokens or not doc_tokens:
        return False
    doc_set: Set[str] = set(doc_tokens)
    for token in tokens:
        if token in doc_set:
            return True
        for doc_token in doc_set:
            if SequenceMatcher(None, token, doc_token).ratio() >= threshold:
                return True
    return False


def _ensure_relevance(keywords: List[str], document_text: str) -> None:
    if not keywords or not document_text:
        return
    doc_lower = document_text.lower()
    doc_tokens = _tokenize_text(doc_lower)
    doc_token_set = set(doc_tokens)
    for keyword in keywords:
        if not keyword:
            continue
        lowered = keyword.lower()
        if lowered in doc_lower:
            return
        kw_tokens = _tokenize_text(lowered)
        if any(token in doc_token_set for token in kw_tokens):
            return
        if _fuzzy_token_match(kw_tokens, doc_tokens):
            return
    raise TopicIrrelevantError("Requested topic isn't covered by this document.")


def ensure_topic_relevance(topic: Optional[str], document_text: str) -> None:
    """
    Validate that at least one keyword from the topic exists in the document text.
    """
    keywords = _extract_keywords(topic)
    _ensure_relevance(keywords, document_text)


def ensure_any_relevance(values: Iterable[Optional[str]], document_text: str) -> None:
    """
    Validate that at least one keyword from the provided values exists in the document.
    """
    keywords: List[str] = []
    for value in values:
        keywords.extend(_extract_keywords(value))
    _ensure_relevance(keywords, document_text)


def _bootstrap_default_document() -> None:
    try:
        default_text = extract_text(str(document_path))
    except Exception as exc:  # pragma: no cover - startup logging
        print(f"⚠️ Failed to load default document: {exc}")
        default_text = ""

    DOCUMENT_STORE[DEFAULT_DOCUMENT_ID] = {
        "text": default_text,
        "filename": document_path.name,
        "word_count": len(default_text.split()),
        "question_history": [],
    }


def _get_document(document_id: Optional[str]) -> DocumentRecord:
    if document_id:
        doc = DOCUMENT_STORE.get(document_id)
        if not doc:
            raise ValueError("Document not found.")
        return doc
    default_doc = DOCUMENT_STORE.get(DEFAULT_DOCUMENT_ID)
    if not default_doc:
        raise ValueError("Default document missing.")
    return default_doc


def _format_profile_block(profile: Optional[Dict[str, Any]]) -> str:
    if not profile:
        return ""
    try:
        serialized = json.dumps(profile, ensure_ascii=False)
    except TypeError:
        serialized = str(profile)
    return f"""
Learner profile:
{serialized}

Use these strengths, weaknesses and knowledge gaps to prioritize what to surface first.
""".strip()


def _extract_concepts(text: str) -> List[Dict[str, str]]:
    """
    Use the LLM to break the document into a small set of distinct concepts.

    Returns a list of { "title": str, "summary": str } items.
    """
    from bedrock_client import bedrock_completion

    excerpt = text[:6000]
    prompt = f"""
You are a product knowledge designer.

From the following product document, identify 4–7 distinct key concepts or features that a sales rep should learn.

For each concept, provide:
- a short, punchy title (max 8 words)
- a 3–4 sentence explanation focused only on that concept (aim for 90–120 words), suitable for a standalone "knowledge card".

Respond ONLY with valid compact JSON in this exact shape:
{{
  "concepts": [
    {{ "title": "string", "summary": "string" }}
  ]
}}

Do NOT include any other keys, comments, markdown or prose.

Document:
\"\"\"
{excerpt}
\"\"\"
"""
    try:
        raw = bedrock_completion(prompt, max_tokens=700, temperature=0.6)
        json_start = raw.find("{")
        json_end = raw.rfind("}")
        if json_start == -1 or json_end == -1:
            raise ValueError("Model response was not valid JSON.")
        payload = json.loads(raw[json_start : json_end + 1])
        concepts = payload.get("concepts") or []
        cleaned: List[Dict[str, str]] = []
        for item in concepts:
            title = str(item.get("title", "")).strip()
            summary = str(item.get("summary", "")).strip()
            if title and summary:
                cleaned.append({"title": title, "summary": summary})
        if not cleaned:
            raise ValueError("No valid concepts returned.")
        return cleaned
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Failed to extract concepts for knowledge cards:", exc)
        # Fallback: use a single high-level overview as one concept
        overview = _summarize_text(text, None)
        return [{"title": "Overview", "summary": overview}]


def _summarize_text(text: str, llm) -> str:
    from bedrock_client import bedrock_completion

    excerpt = text[:5000]
    prompt = f"""
You are a knowledge curator. Write a concise neutral summary (2-3 sentences) of the following document excerpt for a sales coach dashboard. Keep it under 70 words.

Document:
\"\"\" 
{excerpt}
\"\"\"
"""
    try:
        return bedrock_completion(prompt, max_tokens=200, temperature=0.4)
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Failed to summarize document:", exc)
        return text[:200]


def _create_quiz(
    text: str,
    history: Optional[List[str]] = None,
    topic: Optional[str] = None,
    learner_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    from bedrock_client import bedrock_completion

    excerpt = text[:4000]
    asked = history or []
    asked_block = "\n".join(f"- {q}" for q in asked) if asked else "None yet."
    topic_block = (
        f"\nFocus the question narrowly on this learner-selected topic or gap: \"{topic.strip()}\".\n"
        if topic
        else "\nFeel free to cover any foundational part of the document that reinforces mastery.\n"
    )
    profile_block = _format_profile_block(learner_profile)
    prompt = f"""
Create exactly one multiple-choice question about the following document excerpt. Provide 4 answer choices labeled A-D and indicate the correct label.

Avoid repeating any of these previous quiz questions:
{asked_block}

{topic_block}

{profile_block}

Respond with valid JSON using this schema:
{{
  "question": "string",
  "options": [
    {{ "label": "A", "text": "string" }},
    {{ "label": "B", "text": "string" }},
    {{ "label": "C", "text": "string" }},
    {{ "label": "D", "text": "string" }}
  ],
  "answer": "A",
  "explanation": "string"
}}

Document:
\"\"\"
{excerpt}
\"\"\"
"""
    try:
        raw = bedrock_completion(prompt, max_tokens=400, temperature=0.7)
        json_start = raw.find("{")
        json_end = raw.rfind("}")
        if json_start == -1 or json_end == -1:
            raise ValueError("Model response was not valid JSON.")
        payload = json.loads(raw[json_start : json_end + 1])
        return payload
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Failed to generate quiz:", exc)
        return {
            "question": "Which benefit resonates most with customers?",
            "options": [
                {"label": "A", "text": "Better sound quality"},
                {"label": "B", "text": "Longer battery life"},
                {"label": "C", "text": "Compact design"},
                {"label": "D", "text": "Intuitive controls"},
            ],
            "answer": "A",
            "explanation": "Highlighting tangible improvements reinforces value.",
        }


def _build_topic_card(
    document_text: str,
    document_id: str,
    topic: str,
    learner_profile: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    from bedrock_client import bedrock_completion

    excerpt = document_text[:6000]
    profile_block = _format_profile_block(learner_profile)
    prompt = f"""
You are a sales enablement strategist who builds focused knowledge cards.

Using the following document excerpt, craft a single card that dives into the learner's requested topic: "{topic}".
Keep the tone practical and coach-like. Stay concise (80-110 words) and highlight what matters most for a rep in the field.

{profile_block}

Return JSON shaped exactly like:
{{
  "title": "string",
  "summary": "string"
}}

Document:
\"\"\" 
{excerpt}
\"\"\"
"""
    try:
        raw = bedrock_completion(prompt, max_tokens=450, temperature=0.55)
        json_start = raw.find("{")
        json_end = raw.rfind("}")
        if json_start == -1 or json_end == -1:
            raise ValueError("Model response was not valid JSON.")
        payload = json.loads(raw[json_start : json_end + 1])
        title = str(payload.get("title", "") or topic).strip() or "Focused insight"
        summary = str(payload.get("summary", "")).strip() or "Here's what to know."
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Failed to build topic knowledge card:", exc)
        title = topic or "Key insight"
        summary = "Let's double down on this area from the document."

    filename = f"knowledge-topic-{document_id}-{uuid4().hex}.mp3"
    audio_path = Path(UPLOAD_DIR) / filename
    audio_url = ""
    generated_path = generate_tts(summary, str(audio_path))
    if generated_path:
        audio_url = f"{settings.MEDIA_URL.strip('/')}/{Path(generated_path).name}"

    return {
        "title": title,
        "snippet": summary,
        "audioUrl": audio_url,
        "background": "#efe6ff",
    }


def build_knowledge_card(
    document_id: str,
    preference: str = "pathway",
    topic: Optional[str] = None,
    learner_profile: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Build a *single-concept* knowledge card for the given document.

    Rather than summarising the whole document once, we:
    - break it into multiple concepts (title + summary)
    - on each call, return the next concept in the list
    - generate and cache TTS audio per concept.
    """
    doc = _get_document(document_id)

    # Lazily compute concept list on first request.
    preference_normalized = (preference or "pathway").lower()

    if preference_normalized == "topic" and topic:
        ensure_topic_relevance(topic, doc["text"])
        return _build_topic_card(doc["text"], document_id, topic, learner_profile)

    concepts = _ensure_concepts(doc)
    if not concepts:
        # Extremely defensive: fall back to a simple snippet.
        snippet = _summarize_text(doc["text"], None)
        filename = f"knowledge-{document_id}.mp3"
        audio_path = Path(UPLOAD_DIR) / filename
        generated_path = generate_tts(snippet, str(audio_path))
        audio_url = ""
        if generated_path:
            audio_url = f"{settings.MEDIA_URL.strip('/')}/{Path(generated_path).name}"
        return {
            "title": "Overview",
            "snippet": snippet,
            "audioUrl": audio_url,
            "background": "#efe6ff",
        }

    index = int(doc.get("knowledge_index", 0)) % len(concepts)
    concept = concepts[index]
    # Advance index for next call (cycle through concepts).
    doc["knowledge_index"] = (index + 1) % len(concepts)

    title = concept.get("title") or "Key concept"
    snippet = concept.get("summary") or ""

    # Generate (and cache) audio per concept title.
    audio_map: Dict[str, str] = doc.get("knowledge_audio_map") or {}
    audio_url = audio_map.get(title, "")
    if not audio_url and snippet:
        safe_slug = "".join(c for c in title.lower() if c.isalnum() or c in ("-", "_")) or "concept"
        filename = f"knowledge-{document_id}-{safe_slug}.mp3"
        audio_path = Path(UPLOAD_DIR) / filename
        generated_path = generate_tts(snippet, str(audio_path))
        if generated_path:
            audio_url = f"{settings.MEDIA_URL.strip('/')}/{Path(generated_path).name}"
            audio_map[title] = audio_url
            doc["knowledge_audio_map"] = audio_map

    return {
        "title": title,
        "snippet": snippet,
        "audioUrl": audio_url,
        # Colour hint; front-end can ignore if using its own CSS,
        # but we align with the previous purple knowledge card palette.
        "background": "#efe6ff",
    }


def ensure_bootstrapped() -> None:
    if DEFAULT_DOCUMENT_ID not in DOCUMENT_STORE:
        _bootstrap_default_document()


def _ensure_concepts(doc: DocumentRecord) -> List[Dict[str, str]]:
    if "knowledge_concepts" not in doc:
        doc["knowledge_concepts"] = _extract_concepts(doc["text"])
        doc["knowledge_index"] = 0
        doc["knowledge_audio_map"] = {}
    return doc.get("knowledge_concepts", [])


def get_knowledge_concepts(document_id: str) -> List[Dict[str, str]]:
    doc = _get_document(document_id)
    return _ensure_concepts(doc)


