import os
import sys

# Ensure modules can be resolved relative to ai-services root
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vision.classifier import DamageClassifier
from speech.transcriber import AudioTranscriber
from nlp.structuring import TextStructurer

class IntelligencePipeline:
    def __init__(self):
        # Defaulting to mock for extremely fast local UI validation capability. 
        # Flip to False to download and execute the real PyTorch models.
        self.vision = DamageClassifier(use_mock=True)
        self.speech = AudioTranscriber(use_mock=True)
        self.nlp = TextStructurer(use_mock=True)

    def process_report_assets(self, image_bytes=None, audio_bytes=None, raw_text=None) -> dict:
        results = {
            "vision_analysis": None,
            "speech_analysis": None,
            "nlp_analysis": None,
            "overall_severity": "UNKNOWN",
            "confidence_score": 0.0
        }

        if image_bytes:
            vis = self.vision.analyze_image(image_bytes)
            results["vision_analysis"] = vis
            if vis["is_damaged"]:
                results["overall_severity"] = "SEVERE" if vis["damage_score"] > 0.8 else "MODERATE"
                results["confidence_score"] = vis["confidence"]

        if audio_bytes:
            speech = self.speech.transcribe(audio_bytes)
            results["speech_analysis"] = speech
            raw_text = speech["text"]

        if raw_text:
            results["nlp_analysis"] = self.nlp.parse_text(raw_text)
            
        return results
