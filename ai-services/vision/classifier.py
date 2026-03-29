from PIL import Image
import io

class DamageClassifier:
    """
    Evaluates image arrays mapping to zero-shot damage labels utilizing the OpenAI CLIP model structure.
    """
    def __init__(self, use_mock=True):
        self.use_mock = use_mock
        if not self.use_mock:
            from transformers import pipeline
            # Zero-shot classification using CLIP for detecting specific disaster damage
            self.classifier = pipeline("zero-shot-image-classification", model="openai/clip-vit-base-patch32")
            self.labels = [
                "flooded road", "collapsed bridge", "damaged hospital", 
                "destroyed residential house", "fallen power lines", "normal infrastructure"
            ]

    def analyze_image(self, image_bytes: bytes) -> dict:
        if self.use_mock:
            # High-speed deterministic mock for pipeline validation without forcing 2GB downloads
            return {
                "detected_label": "collapsed bridge",
                "damage_score": 0.95,
                "is_damaged": True,
                "confidence": 0.92
            }

        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        results = self.classifier(image, candidate_labels=self.labels)
        
        # Results are automatically sorted descending by confidence structure
        top_label = results[0]["label"]
        top_score = results[0]["score"]
        
        is_damaged = top_label != "normal infrastructure"
        
        return {
            "detected_label": top_label,
            "damage_score": top_score if is_damaged else 0.1,
            "is_damaged": is_damaged,
            "confidence": top_score
        }
