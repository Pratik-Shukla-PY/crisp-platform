class MockAIService:
    def transcribe_audio(self, path: str) -> str:
        return "Audio transcribed from mockup."
        
    def analyze_image(self, path: str) -> dict:
        return {"labels": ["mock_infrastructure"], "risk_score": 1.0}

ai_service = MockAIService()
