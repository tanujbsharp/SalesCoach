from bedrock_client import bedrock_completion

RUBRIC_CATEGORIES = [
    "Clarity",
    "Confidence & Tone",
    "Relevance",
    "Completeness",
    "Accuracy"
]

def generate_question(context: str, history: list[str] = []) -> str:
    asked_categories = [
        cat for cat in RUBRIC_CATEGORIES if any(cat.lower() in q.lower() for q in history)
    ]
    remaining = [cat for cat in RUBRIC_CATEGORIES if cat not in asked_categories]

    next_category = remaining[0] if remaining else "Clarity"
    past_qs = "\n".join(f"- {q}" for q in history) if history else "None"

    prompt = f"""
You are an AI sales coach.

Using the product information below, generate **one simple** sales training question that checks for **only one thing**: **{next_category}**.

Do not include any other criteria. Keep the question short and to the point.

Avoid repeating any of these:
{past_qs}

Product Info:
{context}

Output ONLY the question. No extra text.
"""

    try:
        reply = bedrock_completion(prompt, max_tokens=200, temperature=0.6)
        return reply.strip()
    except Exception as e:
        print("❌ Question generation failed:", e)
        return f"Briefly demonstrate your {next_category.lower()} when explaining a feature."