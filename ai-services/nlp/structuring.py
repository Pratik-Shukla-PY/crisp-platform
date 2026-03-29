class TextStructurer:
    """
    NLP layer to structure raw transcriptions or bot messages into the defined CRISP schema constraints.
    """
    def __init__(self, use_mock=True):
        self.use_mock = use_mock

    def parse_text(self, text: str) -> dict:
        if self.use_mock:
            return {
                "infrastructure_type": "ROAD",
                "severity": "SEVERE",
                "keywords": ["flooded", "tree", "blocking"]
            }
        
        # In production, this would invoke a fast local LLM (like Llama-3-8B) or OpenAI API.
        # For this challenge MVP setup, we can use simple but robust keyword heuristics.
        text_lower = text.lower()
        infra = "OTHER"
        if "bridge" in text_lower or "road" in text_lower or "street" in text_lower:
            infra = "ROAD"
        elif "hospital" in text_lower or "clinic" in text_lower:
            infra = "HOSPITAL"
        elif "house" in text_lower or "residential" in text_lower:
            infra = "HOUSE"
            
        sev = "UNKNOWN"
        if "collapse" in text_lower or "destroy" in text_lower or "severe" in text_lower:
            sev = "SEVERE"
        elif "damage" in text_lower or "flood" in text_lower:
            sev = "MODERATE"
            
        return {
            "infrastructure_type": infra,
            "severity": sev,
            "keywords": []
        }
