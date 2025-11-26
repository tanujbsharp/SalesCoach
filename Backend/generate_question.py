import json
from typing import Any, Dict, List, Optional

from bedrock_client import bedrock_completion

RUBRIC_CATEGORIES = [
    "Clarity",
    "Confidence & Tone",
    "Relevance",
    "Completeness",
    "Accuracy",
]


def _format_profile(profile: Optional[Dict[str, Any]]) -> str:
    if not profile:
        return ""
    try:
        serialized = json.dumps(profile, ensure_ascii=False)
    except TypeError:
        serialized = str(profile)
    return f"""
Learner profile context:
{serialized}

Use this to mirror their strengths, address weaknesses, and fill gaps.
""".strip()


def generate_question(
    context: str,
    history: Optional[List[str]] = None,
    preference: str = "classic",
    filters: Optional[Dict[str, str]] = None,
    description: Optional[str] = None,
    learner_profile: Optional[Dict[str, Any]] = None,
) -> str:
    history = history or []
    asked_categories = [
        cat for cat in RUBRIC_CATEGORIES if any(cat.lower() in q.lower() for q in history)
    ]
    remaining = [cat for cat in RUBRIC_CATEGORIES if cat not in asked_categories]

    next_category = remaining[0] if remaining else "Clarity"
    past_qs = "\n".join(f"- {q}" for q in history) if history else "None"

    preference_normalized = (preference or "classic").lower()
    filters = filters or {}

    description = (description or filters.get("summary") if filters else "") or ""

    detail_lines = []
    for label, key in [
        ("Intent", "intent"),
        ("Industry", "industry"),
        ("Customer situation", "situation"),
        ("Objection", "objection"),
        ("Target audience", "audience"),
    ]:
        value = filters.get(key, "").strip() if filters else ""
        if value:
            detail_lines.append(f"- {label}: {value}")

    if description:
        detail_lines.append(f"- Learner brief: {description.strip()}")

    details_blob = "\n".join(detail_lines) if detail_lines else "- Use your best judgement from the document context."

    if preference_normalized == "classic":
        scenario_block = f"""
Design a practical scenario that measures **{next_category}** for a general sales call.
Give the user a customer situation and a single clear task they must perform.
"""
    else:
        scenario_block = f"""
Craft a bespoke scenario that incorporates the following learner inputs:
{details_blob}

If any element is missing, infer a realistic intent, industry, audience, and situation based on the product context.
Still ensure the task probes **{next_category}**.
"""

    profile_block = _format_profile(learner_profile)

    prompt = f"""
You are an AI sales coach.

Using the product information below, generate ONE practical scenario prompt. It should feel like a real conversation starter the learner can respond to.

Avoid repeating any of these previous prompts:
{past_qs}

{scenario_block}

{profile_block}

Keep it under 120 words and end with a direct instruction such as "How would you respond?".

Product Info:
\"\"\"
{context}
\"\"\"

Output ONLY the scenario prompt. No extra commentary.
"""

    try:
        reply = bedrock_completion(prompt, max_tokens=260, temperature=0.65)
        return reply.strip()
    except Exception as e:
        print("❌ Question generation failed:", e)
        return f"Briefly demonstrate your {next_category.lower()} when explaining a feature."