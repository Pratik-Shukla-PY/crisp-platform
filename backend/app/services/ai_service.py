"""
CRISP AI Service — Local Whisper-based audio transcription.

Uses faster-whisper (CTranslate2) for on-device transcription.
Model: 'base' (good speed/accuracy balance on CPU).

Key feature: task="translate" ensures ALL audio (Hindi, Spanish, Arabic, etc.)
is output as English text — critical for control center operators.

Used by: backend chunk assembly, IVR webhook, partial transcription during upload.
"""
import os
import logging
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

class AIService:
    def __init__(self):
        # Initialize Whisper model: 'base' provides good balance of speed/accuracy
        # Models available: tiny, base, small, medium, large
        # tiny: fastest, lowest accuracy; large: slowest, highest accuracy
        try:
            self.whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
            logger.info("Whisper model 'base' loaded successfully")
        except Exception as e:
            logger.error(f"Failed to load Whisper model: {e}")
            self.whisper_model = None

    def transcribe_audio(self, path: str, translate_to_english: bool = True) -> str:
        """
        Transcribe audio file using faster-whisper (local, no API calls).
        Always translates to English so control-panel admins see English text,
        regardless of the source language (Hindi, Spanish, Arabic, etc.).

        Args:
            path (str): File path to audio file
            translate_to_english (bool): If True, always output English (default True)

        Returns:
            str: Transcribed text in English (empty string if transcription fails)
        """
        if not os.path.exists(path):
            logger.error(f"Audio file not found: {path}")
            return ""

        if self.whisper_model is None:
            logger.warning("Whisper model not available, returning empty transcription")
            return ""

        try:
            logger.info(f"Starting transcription for {path}")

            # Use "translate" task to always output English regardless of source language
            task = "translate" if translate_to_english else "transcribe"
            segments, info = self.whisper_model.transcribe(
                path,
                language=None,  # Auto-detect source language
                beam_size=5,
                vad_filter=True,
                task=task,      # "translate" → always English output
            )

            segments_list = list(segments)
            logger.info(f"Transcription generated {len(segments_list)} segments (task={task})")

            full_text = " ".join([segment.text.strip() for segment in segments_list if segment.text]).strip()

            if full_text:
                logger.info(f"✓ Transcribed {path}: {len(full_text)} chars, source_lang={info.language}, task={task}")
                return full_text
            else:
                logger.warning(f"⚠ No speech detected in {path}")
                return ""

        except Exception as e:
            logger.error(f"✗ Transcription failed for {path}: {type(e).__name__}: {e}")
            import traceback
            logger.error(traceback.format_exc())
            return ""

    def transcribe_audio_partial(self, path: str, translate_to_english: bool = True) -> str:
        """
        Fast transcription of a partial audio file (e.g. _partial.webm).
        Uses beam_size=1 for speed. When translate_to_english=True, outputs
        English text regardless of source language (uses Whisper's translate task).
        """
        if not os.path.exists(path):
            return ""
        if self.whisper_model is None:
            return ""
        try:
            task = "translate" if translate_to_english else "transcribe"
            segments, info = self.whisper_model.transcribe(
                path,
                language=None,
                beam_size=1,
                vad_filter=True,
                task=task,
            )
            text = " ".join([s.text.strip() for s in segments if s.text]).strip()
            if text:
                logger.info(f"Partial transcription ({task}): {len(text)} chars, lang={info.language}")
            return text
        except Exception as e:
            logger.warning(f"Partial transcription failed: {e}")
            return ""

    def analyze_image(self, path: str) -> dict:
        """
        Analyze image for damage/labels.
        Currently returns placeholder data.
        Can be extended with actual ML models (e.g., YOLOv8).
        """
        if not os.path.exists(path):
            logger.error(f"Image file not found: {path}")
            return {"labels": [], "risk_score": 0.0}

        # Placeholder implementation
        return {
            "labels": ["infrastructure_damage"],
            "risk_score": 0.5,
            "damage_detected": True
        }

# Initialize global service instance
ai_service = AIService()
