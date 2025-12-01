import json
from pathlib import Path
from typing import Any, Dict, List, Optional
from uuid import uuid4

BASE_DIR = Path(__file__).resolve().parent.parent
ADMIN_CONFIG_PATH = BASE_DIR / "admin_config.json"

ALLOWED_FILTER_KEYS = {"intent", "industry", "situation", "objection", "audience", "summary"}

DEFAULT_ADMIN_CONFIG: Dict[str, Any] = {
    "mandatoryScenarios": [],
    "minimums": {"knowledge": 0, "quiz": 0, "scenario": 0},
}


def _normalize_minimum(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, parsed)


def _sanitize_filters(raw_filters: Any) -> Dict[str, str]:
    sanitized: Dict[str, str] = {}
    if not isinstance(raw_filters, dict):
        return sanitized
    for key, value in raw_filters.items():
        if key not in ALLOWED_FILTER_KEYS:
            continue
        if value is None:
            continue
        text = str(value).strip()
        if not text:
            continue
        sanitized[key] = text
    return sanitized


def _sanitize_scenario(entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    question = str(entry.get("question", "")).strip()
    if not question:
        return None
    scenario_id = str(entry.get("id") or uuid4())
    title = str(entry.get("title", "")).strip()
    summary = str(entry.get("summary", "")).strip()
    preference = str(entry.get("preference", "classic")).strip().lower()
    if preference not in {"classic", "tailored"}:
        preference = "classic"
    scenario: Dict[str, Any] = {
        "id": scenario_id,
        "title": title,
        "question": question,
        "summary": summary,
        "preference": preference,
    }
    filters = _sanitize_filters(entry.get("filters"))
    if filters:
        scenario["filters"] = filters
    return scenario


def _normalize_config(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    scenarios: List[Dict[str, Any]] = []
    for entry in raw.get("mandatoryScenarios", []):
        if not isinstance(entry, dict):
            continue
        sanitized = _sanitize_scenario(entry)
        if sanitized:
            scenarios.append(sanitized)
    minimums = raw.get("minimums") or {}
    normalized = {
        "mandatoryScenarios": scenarios,
        "minimums": {
            "knowledge": _normalize_minimum(minimums.get("knowledge")),
            "quiz": _normalize_minimum(minimums.get("quiz")),
            "scenario": _normalize_minimum(minimums.get("scenario")),
        },
    }
    return normalized


def load_admin_config() -> Dict[str, Any]:
    if not ADMIN_CONFIG_PATH.exists():
        return DEFAULT_ADMIN_CONFIG.copy()
    try:
        with open(ADMIN_CONFIG_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return DEFAULT_ADMIN_CONFIG.copy()
    return _normalize_config(data)


def save_admin_config(raw: Dict[str, Any]) -> Dict[str, Any]:
    config = _normalize_config(raw)
    try:
        with open(ADMIN_CONFIG_PATH, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
    except OSError:
        # If saving fails, fallback to returning normalized config without persisting.
        pass
    return config

