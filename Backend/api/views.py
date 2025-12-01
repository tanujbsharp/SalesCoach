import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

from django.http import HttpRequest, JsonResponse, HttpResponseBadRequest
from django.views.decorators.csrf import csrf_exempt

from document import extract_text
from evaluate import evaluate_response
from generate_question import generate_question
from transcribe import transcribe_audio

from bedrock_client import bedrock_completion

from .admin_config import load_admin_config, save_admin_config
from .services import (
    QUIZ_STORE,
    UPLOAD_DIR,
    TopicIrrelevantError,
    _create_quiz,
    _get_document,
    build_knowledge_card,
    ensure_any_relevance,
    ensure_bootstrapped,
    ensure_topic_relevance,
    get_knowledge_concepts,
)


ensure_bootstrapped()


def _parse_profile(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    profile = data.get("learnerProfile")
    if isinstance(profile, dict):
        return profile
    return None


def _format_profile_blob(profile: Optional[Dict[str, Any]]) -> str:
    if not profile:
        return ""
    try:
        serialized = json.dumps(profile, ensure_ascii=False)
    except TypeError:
        serialized = str(profile)
    return f"""
Here is the learner profile with known strengths, weaknesses, and knowledge gaps:
{serialized}

Reference it to personalize your coaching.
"""


@csrf_exempt
def upload_document(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    file = request.FILES.get("file")
    if not file:
        return HttpResponseBadRequest("Missing file")

    ext = Path(file.name).suffix.lower()
    if ext not in {".docx", ".pptx", ".ppt", ".pdf"}:
        return JsonResponse({"detail": "Unsupported file type."}, status=400)

    doc_id = str(uuid4())
    saved_path = Path(UPLOAD_DIR) / f"{doc_id}{ext}"
    with open(saved_path, "wb") as out:
        for chunk in file.chunks():
            out.write(chunk)

    try:
        text = extract_text(str(saved_path))
    except ValueError as exc:
        return JsonResponse({"detail": str(exc)}, status=400)

    from .services import DOCUMENT_STORE

    DOCUMENT_STORE[doc_id] = {
        "text": text,
        "filename": file.name,
        "word_count": len(text.split()),
        "question_history": [],
    }

    return JsonResponse(
        {
            "documentId": doc_id,
            "filename": file.name,
            "wordCount": len(text.split()),
            "charCount": len(text),
        }
    )


@csrf_exempt
def get_knowledge_card(request: HttpRequest):
    if request.method == "POST":
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            return HttpResponseBadRequest("Invalid JSON")
        document_id = payload.get("documentId")
        preference = payload.get("preference") or "pathway"
        topic = payload.get("topic")
        learner_profile = _parse_profile(payload)
    else:
        document_id = request.GET.get("documentId")
        preference = "pathway"
        topic = None
        learner_profile = None

    try:
        data = build_knowledge_card(document_id or "", preference, topic, learner_profile)
    except TopicIrrelevantError as exc:
        return JsonResponse({"detail": str(exc)}, status=400)
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)
    return JsonResponse(data)


def list_knowledge_concepts(request: HttpRequest):
    document_id = request.GET.get("documentId")
    try:
        concepts = get_knowledge_concepts(document_id or "")
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)
    return JsonResponse({"concepts": concepts})


def get_topic(request: HttpRequest):
    document_id = request.GET.get("documentId")
    try:
        document = _get_document(document_id)
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)

    excerpt = document["text"][:4000]
    prompt = f"""
You are a helpful assistant.

Given the following product document, return a short 3–7 word topic or title that best describes what it is about.
Respond with ONLY that short phrase, no extra sentences.

Document:
\"\"\"
{excerpt}
\"\"\"
"""
    try:
        reply = bedrock_completion(prompt, max_tokens=32, temperature=0.3)
        topic = reply.strip().splitlines()[0].strip()
        if not topic:
            topic = "this product"
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Failed to derive topic:", exc)
        topic = "this product"

    return JsonResponse({"topic": topic})


@csrf_exempt
def get_scenario(request: HttpRequest):
    if request.method == "POST":
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            return HttpResponseBadRequest("Invalid JSON")
        document_id = payload.get("documentId")
        preference = payload.get("preference") or "classic"
        raw_filters = payload.get("filters") or {}
        filters = {}
        for key, value in raw_filters.items():
            if value is None:
                continue
            filters[key] = str(value)
        description = payload.get("description")
        learner_profile = _parse_profile(payload)
    else:
        document_id = request.GET.get("documentId")
        preference = "classic"
        filters = {}
        description = None
        learner_profile = None

    try:
        document = _get_document(document_id)
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)

    document_text = document["text"]
    try:
        if description or filters:
            ensure_any_relevance([description, *filters.values()], document_text)
    except TopicIrrelevantError as exc:
        return JsonResponse({"detail": str(exc)}, status=400)

    history: List[str] = document.setdefault("question_history", [])
    question = generate_question(
        document_text,
        history,
        preference=preference,
        filters=filters,
        description=description,
        learner_profile=learner_profile,
    )
    history.append(question)
    return JsonResponse({"question": question})


@csrf_exempt
def evaluate_scenario(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    try:
        data = json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError:
        return HttpResponseBadRequest("Invalid JSON")

    document_id = data.get("documentId")
    response_text = data.get("response", "")
    document = _get_document(document_id)
    feedback, score = evaluate_response(response_text, document["text"])

    # Log this scenario attempt so we can analyze strengths/weaknesses later.
    assessments = document.setdefault("assessments", [])
    assessments.append(
        {
            "type": "scenario",
            "response": response_text,
            "score": score,
            "feedback": feedback,
        }
    )

    return JsonResponse({"score": score, "feedback": feedback})


@csrf_exempt
def get_quiz(request: HttpRequest):
    if request.method == "POST":
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            return HttpResponseBadRequest("Invalid JSON")
        document_id = payload.get("documentId")
        topic = payload.get("topic")
        learner_profile = _parse_profile(payload)
    else:
        document_id = request.GET.get("documentId")
        topic = None
        learner_profile = None

    try:
        document = _get_document(document_id)
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)

    document_text = document["text"]
    try:
        if topic:
            ensure_topic_relevance(topic, document_text)
    except TopicIrrelevantError as exc:
        return JsonResponse({"detail": str(exc)}, status=400)

    history: List[str] = document.setdefault("quiz_history", [])
    quiz = _create_quiz(document_text, history, topic=topic, learner_profile=learner_profile)
    # Remember which document this quiz belongs to so we can log performance.
    quiz["document_id"] = document_id
    quiz["topic"] = topic
    quiz_id = str(uuid4())
    QUIZ_STORE[quiz_id] = quiz
    # Remember this question so we don't repeat it next time.
    if quiz.get("question"):
        history.append(str(quiz["question"]))
    return JsonResponse(
        {
            "quizId": quiz_id,
            "question": quiz["question"],
            "options": quiz["options"],
            "topic": topic,
        }
    )


@csrf_exempt
def submit_quiz(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    try:
        data = json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError:
        return HttpResponseBadRequest("Invalid JSON")

    quiz_id = data.get("quizId")
    selected_option = data.get("selectedOption", "")
    quiz = QUIZ_STORE.get(quiz_id)
    if not quiz:
        return JsonResponse({"detail": "Quiz not found."}, status=404)

    selected = selected_option.strip().upper()
    is_correct = selected == quiz["answer"].upper()

    # Log this quiz attempt against the underlying document, if available.
    document_id = quiz.get("document_id")
    if document_id:
        try:
            document = _get_document(document_id)
            assessments = document.setdefault("assessments", [])
            assessments.append(
                {
                    "type": "quiz",
                    "question": quiz.get("question", ""),
                    "topic": quiz.get("topic", ""),
                    "selected": selected,
                    "correct_answer": quiz.get("answer", ""),
                    "correct": is_correct,
                    "explanation": quiz.get("explanation", ""),
                }
            )
        except ValueError:
            # If document is missing, just skip logging.
            pass
    return JsonResponse(
        {
            "correct": is_correct,
            "explanation": quiz["explanation"],
            "answer": quiz["answer"],
        }
    )


def get_question(request: HttpRequest):
    document_id: Optional[str] = request.GET.get("documentId")
    document = _get_document(document_id)
    history: List[str] = document.setdefault("question_history", [])
    question = generate_question(document["text"], history)
    history.append(question)
    return JsonResponse({"question": question})


@csrf_exempt
def handle_text(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    try:
        data: Dict[str, Any] = json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError:
        return HttpResponseBadRequest("Invalid JSON")

    user_text = data.get("text", "")
    document_id = data.get("documentId")
    document = _get_document(document_id)
    feedback, score = evaluate_response(user_text, document["text"])

    # Log this free-text assessment as well.
    assessments = document.setdefault("assessments", [])
    assessments.append(
        {
            "type": "text",
            "response": user_text,
            "score": score,
            "feedback": feedback,
        }
    )
    return JsonResponse(
        {
            "score": score,
            "feedback": feedback,
            "audio_url": "",
            "transcript": user_text,
        }
    )


@csrf_exempt
def handle_audio(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    document_id: Optional[str] = request.GET.get("documentId") or request.POST.get("documentId")
    file = request.FILES.get("file")
    if not file:
        return HttpResponseBadRequest("Missing file")

    document = _get_document(document_id)
    audio_path = Path(UPLOAD_DIR) / f"audio-{uuid4()}-{file.name}"
    with open(audio_path, "wb") as f:
        for chunk in file.chunks():
            f.write(chunk)

    transcript = transcribe_audio(str(audio_path))
    feedback, score = evaluate_response(transcript, document["text"])

    # Log this spoken assessment.
    assessments = document.setdefault("assessments", [])
    assessments.append(
        {
            "type": "audio",
            "response": transcript,
            "score": score,
            "feedback": feedback,
        }
    )

    return JsonResponse(
        {
            "transcript": transcript,
            "feedback": feedback,
            "score": score,
            "audio_url": "",
        }
    )


@csrf_exempt
def rubric_handler(request: HttpRequest):
    if request.method == "GET":
        try:
            with open("rubric.json", "r") as f:
                rubric = json.load(f)
            return JsonResponse({"rubric": rubric})
        except Exception as e:  # pragma: no cover - file errors
            print("❌ Error loading rubric:", e)
            return JsonResponse({"rubric": []})

    if request.method == "POST":
        try:
            data = json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            return HttpResponseBadRequest("Invalid JSON")

        try:
            with open("rubric.json", "w") as f:
                json.dump(data.get("rubric", []), f, indent=2)
            return JsonResponse({"message": "Rubric saved"})
        except Exception as e:  # pragma: no cover - file errors
            print("❌ Failed to save rubric:", e)
            return JsonResponse({"message": "Error saving rubric"})

    return HttpResponseBadRequest("Invalid method")


@csrf_exempt
def admin_config_handler(request: HttpRequest):
    if request.method == "GET":
        config = load_admin_config()
        return JsonResponse(config)

    if request.method == "POST":
        try:
            payload = json.loads(request.body.decode("utf-8"))
        except json.JSONDecodeError:
            return HttpResponseBadRequest("Invalid JSON")
        config = save_admin_config(payload)
        return JsonResponse(config)

    return HttpResponseBadRequest("Invalid method")


@csrf_exempt
def chat_with_document(request: HttpRequest):
    if request.method != "POST":
        return HttpResponseBadRequest("Invalid method")

    try:
        data: Dict[str, Any] = json.loads(request.body.decode("utf-8"))
    except json.JSONDecodeError:
        return HttpResponseBadRequest("Invalid JSON")

    document_id = data.get("documentId")
    messages = data.get("messages", [])
    learner_profile = _parse_profile(data)

    try:
        document = _get_document(document_id)
    except ValueError:
        return JsonResponse({"detail": "Document not found."}, status=404)

    # Build a simple conversation transcript from the provided messages.
    history_lines: List[str] = []
    for msg in messages:
        role = (msg.get("role") or "user").lower()
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        prefix = "User" if role == "user" else "Assistant"
        history_lines.append(f"{prefix}: {content}")

    conversation = "\n".join(history_lines)

    context_excerpt = document["text"][:6000]

    # Pull any accumulated assessments (scenario/quiz/text/audio).
    assessments = document.get("assessments", [])
    assessments_blob = ""
    if assessments:
        # Provide the assessments to the LLM in a compact JSON form so it can
        # infer strengths, weaknesses and knowledge gaps when the user asks.
        assessments_json = json.dumps(assessments, ensure_ascii=False)
        assessments_blob = f"""
Here is historical performance data for this user across scenarios, quizzes and evaluations:
{assessments_json}

When the user asks about their strengths, weaknesses, progress, or knowledge gaps,
use this data to give a specific, evidence-based summary. Otherwise, keep this in
mind as background context.
"""

    profile_blob = _format_profile_blob(learner_profile)

    prompt = f"""
You are a friendly, concise AI sales coach.

You are helping a user based on the following product document, which is your primary knowledge base:

\"\"\"
{context_excerpt}
\"\"\"

Have a conversational tone, keep answers grounded in the document when possible, and admit when the document does not contain enough information.
Keep replies short and focused (2–4 sentences).

{assessments_blob}

{profile_blob}

Here is the conversation so far:

{conversation}

Assistant:
"""

    try:
        reply = bedrock_completion(prompt, max_tokens=400, temperature=0.6)
        cleaned = reply.strip()
    except Exception as exc:  # pragma: no cover - LLM failures
        print("❌ Chat handling failed:", exc)
        cleaned = "Sorry, I had trouble responding just now. Please try asking your question again."

    return JsonResponse({"reply": cleaned})
