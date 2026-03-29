from fastapi import FastAPI, UploadFile, File, Form
from typing import Optional
import uvicorn
import os
import sys

# Update sys path to allow importing local modules easily
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from pipelines.processor import IntelligencePipeline

app = FastAPI(
    title="CRISP AI Services", 
    version="1.0",
    description="Multimodal PyTorch Intelligence Layer for the CRISP platform"
)
pipeline = IntelligencePipeline()

@app.get("/health", tags=["system"])
def health_check():
    return {"status": "AI Pipeline Online. PyTorch Ready."}

@app.post("/analyze", tags=["analysis"])
async def analyze_report(
    image: Optional[UploadFile] = File(None),
    audio: Optional[UploadFile] = File(None),
    text: Optional[str] = Form(None)
):
    """
    Ingests multimedia assets and text from the Backend sync engine 
    and streams them through the Whisper/CLIP intelligence pipeline.
    """
    image_bytes = await image.read() if image else None
    audio_bytes = await audio.read() if audio else None

    analysis_result = pipeline.process_report_assets(
        image_bytes=image_bytes, 
        audio_bytes=audio_bytes,
        raw_text=text
    )
    
    return analysis_result

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=True)
