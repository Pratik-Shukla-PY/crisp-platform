#!/usr/bin/env python3
"""
Quick test script to verify Whisper transcription works
"""
import os
import sys
from app.services.ai_service import ai_service

def test_transcription():
    print("\n" + "="*60)
    print("CRISP Audio Transcription Test")
    print("="*60)

    # Check if Whisper model is loaded
    if ai_service.whisper_model is None:
        print("❌ Whisper model not loaded!")
        return False

    print("✓ Whisper model loaded successfully")
    print(f"  Model: {ai_service.whisper_model}")

    # Check upload directory
    upload_dir = "uploads"
    if not os.path.exists(upload_dir):
        print(f"❌ Upload directory not found: {upload_dir}")
        return False

    print(f"✓ Upload directory exists: {upload_dir}")

    # List any audio files
    audio_files = [f for f in os.listdir(upload_dir) if f.endswith(('.webm', '.mp3', '.wav', '.flac', '.ogg'))]
    if audio_files:
        print(f"\n✓ Found {len(audio_files)} audio files:")
        for f in audio_files[:5]:
            file_path = os.path.join(upload_dir, f)
            file_size = os.path.getsize(file_path)
            print(f"  - {f} ({file_size:,} bytes)")

            # Try to transcribe
            print(f"    Transcribing {f}...")
            try:
                result = ai_service.transcribe_audio(file_path)
                if result:
                    print(f"    ✓ Result: {result[:100]}...")
                else:
                    print(f"    ⚠ No speech detected or transcription empty")
            except Exception as e:
                print(f"    ❌ Error: {e}")
    else:
        print(f"\n⚠ No audio files found in {upload_dir}")
        print("  Send a report with audio from the mobile app first.")

    print("\n" + "="*60)
    print("Test complete!")
    print("="*60 + "\n")
    return True

if __name__ == "__main__":
    test_transcription()
