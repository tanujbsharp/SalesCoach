import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

import uvicorn
from dotenv import load_dotenv
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from openai import OpenAI
from pydantic import BaseModel

from document import extract_text
from evaluate import evaluate_response
from generate_question import generate_question
from transcribe import transcribe_audio
from tts import generate_tts

load_dotenv()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY is not set. Please update your .env file.")

openai_client = OpenAI(api_key=OPENAI_API_KEY)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

document_path = "knowledge/EchoDot.pptx"

DocumentRecord = Dict[str, Any]
DOCUMENT_STORE: Dict[str, DocumentRecord] = {}
QUIZ_STORE: Dict[str, Dict[str, Any]] = {}
DEFAULT_DOCUMENT_ID = "default"


class ScenarioAnswer(BaseModel):
    documentId: Optional[str] = None
    response: str


class QuizAnswer(BaseModel):
    quizId: str
    selectedOption: str


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


def _bootstrap_default_document() -> None:
    try:
        default_text = extract_text(document_path)
    except Exception as exc:
        print(f"⚠️ Failed to load default document: {exc}")
        default_text = ""

    DOCUMENT_STORE[DEFAULT_DOCUMENT_ID] = {
        "text": default_text,
        "filename": Path(document_path).name,
        "word_count": len(default_text.split()),
        "question_history": [],
    }


def _get_document(document_id: Optional[str]) -> DocumentRecord:
    if document_id:
        doc = DOCUMENT_STORE.get(document_id)
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found.")
        return doc
    default_doc = DOCUMENT_STORE.get(DEFAULT_DOCUMENT_ID)
    if not default_doc:
        raise HTTPException(status_code=404, detail="Default document missing.")
    return default_doc


def _summarize_text(text: str) -> str:
    excerpt = text[:5000]
    prompt = f"""
You are a knowledge curator. Write a concise neutral summary (2-3 sentences) of the following document excerpt for a sales coach dashboard. Keep it under 70 words.

Document:
\"\"\"
{excerpt}
\"\"\"
"""
    try:
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.4,
        )
        return response.choices[0].message.content.strip()
    except Exception as exc:
        print("❌ Failed to summarize document:", exc)
        return text[:200]


def _create_quiz(text: str) -> Dict[str, Any]:
    excerpt = text[:4000]
    prompt = f"""
Create exactly one multiple-choice question about the following document excerpt. Provide 4 answer choices labeled A-D and indicate the correct label. Respond with valid JSON using this schema:
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
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            temperature=0.7,
        )
        raw = response.choices[0].message.content.strip()
        json_start = raw.find("{")
        json_end = raw.rfind("}")
        if json_start == -1 or json_end == -1:
            raise ValueError("Model response was not valid JSON.")
        payload = json.loads(raw[json_start : json_end + 1])
        return payload
    except Exception as exc:
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


_bootstrap_default_document()


@app.post("/api/documents")
async def upload_document(file: UploadFile = File(...)):
    ext = Path(file.filename).suffix.lower()
    if ext not in {".docx", ".pptx", ".ppt", ".pdf"}:
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    doc_id = str(uuid4())
    saved_path = UPLOAD_DIR / f"{doc_id}{ext}"
    with open(saved_path, "wb") as out:
        out.write(await file.read())

    try:
        text = extract_text(str(saved_path))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    DOCUMENT_STORE[doc_id] = {
        "text": text,
        "filename": file.filename,
        "word_count": len(text.split()),
        "question_history": [],
    }

    return {
        "documentId": doc_id,
        "filename": file.filename,
        "wordCount": len(text.split()),
        "charCount": len(text),
    }


@app.get("/api/knowledge-card")
def get_knowledge_card(documentId: str = Query(...)):
    document = _get_document(documentId)
    if not document:
        raise HTTPException(status_code=404, detail="Document not found.")

    if "knowledge_snippet" not in document:
        snippet = _summarize_text(document["text"])
        audio_path = str(UPLOAD_DIR / f"knowledge-{documentId}.mp3")
        generated_path = generate_tts(snippet, audio_path)
        document["knowledge_snippet"] = snippet
        document["knowledge_audio"] = generated_path or ""
    return {
        "snippet": document["knowledge_snippet"],
        "audioUrl": document.get("knowledge_audio"),
        "background": "#E7E5E4",
    }


@app.get("/api/scenario")
def get_scenario(documentId: Optional[str] = Query(None)):
    document = _get_document(documentId)
    history: List[str] = document.setdefault("question_history", [])
    question = generate_question(document["text"], history)
    history.append(question)
    return {"question": question}


@app.post("/api/scenario/answer")
def evaluate_scenario(answer: ScenarioAnswer):
    document = _get_document(answer.documentId)
    feedback, score = evaluate_response(answer.response, document["text"])
    return {"score": score, "feedback": feedback}


@app.get("/api/quiz")
def get_quiz(documentId: Optional[str] = Query(None)):
    document = _get_document(documentId)
    quiz = _create_quiz(document["text"])
    quiz_id = str(uuid4())
    QUIZ_STORE[quiz_id] = quiz
    return {
        "quizId": quiz_id,
        "question": quiz["question"],
        "options": quiz["options"],
    }


@app.post("/api/quiz/answer")
def submit_quiz(answer: QuizAnswer):
    quiz = QUIZ_STORE.get(answer.quizId)
    if not quiz:
        raise HTTPException(status_code=404, detail="Quiz not found.")

    selected = answer.selectedOption.strip().upper()
    is_correct = selected == quiz["answer"].upper()
    return {
        "correct": is_correct,
        "explanation": quiz["explanation"],
        "answer": quiz["answer"],
    }


@app.get("/api/question")
def get_question(documentId: Optional[str] = Query(None)):
    document = _get_document(documentId)
    history: List[str] = document.setdefault("question_history", [])
    question = generate_question(document["text"], history)
    history.append(question)
    return {"question": question}


@app.post("/api/text")
async def handle_text(data: dict = Body(...)):
    user_text = data.get("text", "")
    document_id = data.get("documentId")
    document = _get_document(document_id)
    print("🟡 Received:", user_text)
    feedback, score = evaluate_response(user_text, document["text"])
    return {
        "score": score,
        "feedback": feedback,
        "audio_url": "",
        "transcript": user_text,
    }


@app.post("/api/audio")
async def handle_audio(documentId: Optional[str] = Query(None), file: UploadFile = File(...)):
    document = _get_document(documentId)
    audio_path = UPLOAD_DIR / f"audio-{uuid4()}-{file.filename}"
    with open(audio_path, "wb") as f:
        f.write(await file.read())

    transcript = transcribe_audio(str(audio_path))
    feedback, score = evaluate_response(transcript, document["text"])

    return {
        "transcript": transcript,
        "feedback": feedback,
        "score": score,
        "audio_url": "",
    }


@app.get("/api/rubric")
def get_rubric():
    try:
        with open("rubric.json", "r") as f:
            rubric = json.load(f)
        return {"rubric": rubric}
    except Exception as e:
        print("❌ Error loading rubric:", e)
        return {"rubric": []}


@app.post("/api/rubric")
async def save_rubric(data: dict = Body(...)):
    try:
        with open("rubric.json", "w") as f:
            json.dump(data["rubric"], f, indent=2)
        return {"message": "Rubric saved"}
    except Exception as e:
        print("❌ Failed to save rubric:", e)
        return {"message": "Error saving rubric"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)