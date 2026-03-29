import os
import tempfile

class AudioTranscriber:
    """
    Multilingual speech-to-text integration employing OpenAI's Whisper model architecture.
    """
    def __init__(self, use_mock=True):
        self.use_mock = use_mock
        if not self.use_mock:
            import whisper
            # Tiny model evaluates well on speed constraints for emergency scenarios
            self.model = whisper.load_model("tiny")

    def transcribe(self, audio_bytes: bytes) -> dict:
        if self.use_mock:
            return {
                "text": "ရေကြီးနေပါတယ်။ လမ်းပေါ်မှာသစ်ပင်လဲကျနေတယ်။ (The road is flooded and a tree has fallen.)",
                "language": "my" # Myanmar code
            }

        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as tmp_file:
            tmp_file.write(audio_bytes)
            tmp_path = tmp_file.name

        try:
            result = self.model.transcribe(tmp_path)
            return {
                "text": result["text"],
                "language": result.get("language", "unknown")
            }
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
