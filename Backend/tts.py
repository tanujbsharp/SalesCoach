from pathlib import Path

import pyttsx3
from gtts import gTTS


def generate_tts(text: str, out_path: str = "uploads/response.mp3") -> str:
    """
    Generate an audio narration for the provided text.
    Attempts high-quality MP3 synthesis via gTTS first, then falls back to pyttsx3.
    Returns the relative path to the generated file (or '' if generation failed).
    """

    destination = Path(out_path)
    destination.parent.mkdir(parents=True, exist_ok=True)

    try:
        tts = gTTS(text=text)
        tts.save(destination.as_posix())
        return destination.as_posix()
    except Exception as gtts_error:
        print(f"⚠️ gTTS failed, falling back to pyttsx3: {gtts_error}")

    # Fallback to pyttsx3 (saves as WAV for compatibility on most platforms)
    wav_destination = destination.with_suffix(".wav")
    try:
        engine = pyttsx3.init()
        engine.save_to_file(text, wav_destination.as_posix())
        engine.runAndWait()
        return wav_destination.as_posix()
    except Exception as exc:
        print(f"❌ Failed to generate TTS: {exc}")
        return ""