import json
import os
import re

from better_profanity import profanity
from dotenv import load_dotenv

from bedrock_client import bedrock_completion

load_dotenv()
profanity.load_censor_words()

def load_rubric():
    try:
        with open("rubric.json", "r") as f:
            return json.load(f)
    except Exception as e:
        print("❌ Failed to load rubric:", e)
        return []

def evaluate_response(transcript: str, context: str):
    if profanity.contains_profanity(transcript):
        return "⚠️ Your response contains abusive or inappropriate language. Please refrain from such input.", 0

    rubric = load_rubric()

    # If rubric is empty, fallback to generic evaluation
    if not rubric:
        rubric = [{"name": "Response Quality", "description": "Overall usefulness and correctness of the answer."}]

    rubric_text = "\n".join([f"{i+1}. **{r['name']}** – {r['description']}" for i, r in enumerate(rubric)])
    rubric_html = "\n".join([f"<tr><td>{r['name']}</td><td>X</td><td>...</td></tr>" for r in rubric])

    scoring_guardrails = """
Important grading guardrails:
- Only award an Accuracy score above 5 if the response explicitly references facts from the document (e.g., product specs, feature names, quantitative improvements). If it stays generic, lacks detail, or invents information, Accuracy must be 0–4.
- If the learner skips key document facts entirely, Accuracy should be 2 or below even if there are no blatant errors.
- When in doubt, err on the harsher side so scores reflect real readiness.
""".strip()

    prompt = f"""
You are an AI sales coach. Use the following product document as your knowledge base:

{context}

Now evaluate the sales response below from a user. Consider if the response refers to or correctly explains features from the knowledge base. Be critical but constructive.

User's Response:
\"\"\"
{transcript}
\"\"\"

Evaluate on the following criteria:
{rubric_text}

{scoring_guardrails}

Give each criterion a score on 10 and explain why. Then give an overall average score and write a helpful feedback paragraph for the user to improve next time.

Return the result in this HTML format:

<table border="1" cellpadding="8" cellspacing="0">
<tr><th>Criteria</th><th>Score (on 10)</th><th>Explanation</th></tr>
{rubric_html}
</table>

<b>Score:</b> X on 10

<b>Feedback:</b>
<ul>
  <li>Point 1...</li>
  <li>Point 2...</li>
</ul>
"""

    try:
        print("🔍 Sending prompt to Bedrock...")
        reply = bedrock_completion(prompt, max_tokens=800, temperature=0.4)
        print("✅ Bedrock response received:\n", reply)

        plain_text = re.sub(r"<[^>]+>", "", reply)
        match = re.search(r"Score:\s*([\d.]+)\s*on\s*10", plain_text, re.IGNORECASE)
        score = float(match.group(1)) if match else 0.0

        return reply.strip(), score

    except Exception as e:
        print("❌ Bedrock error:", e)
        return "Sorry, there was a problem evaluating your response.", 0