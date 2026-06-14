"""
Telegram Media Handler - Downloads media from Telegram Bot API servers,
encodes to base64 for CRISP backend consumption.

Video handling: when user sends video (mistaking it for voice note),
extract audio track via ffmpeg and use video thumbnail as image evidence.
"""
import os
import base64
import logging
import tempfile
import subprocess
import httpx

logger = logging.getLogger(__name__)

BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}"
FILE_BASE = f"https://api.telegram.org/file/bot{BOT_TOKEN}"
MAX_RETRIES = 3


async def download_media(file_id: str) -> dict:
    """
    Download media from Telegram servers.
    Returns {data_url, data_b64, mime_type, size_bytes}
    """
    for attempt in range(MAX_RETRIES):
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                r = await c.get(f"{API_BASE}/getFile", params={"file_id": file_id})
                if r.status_code != 200:
                    continue

                result = r.json().get("result", {})
                file_path = result.get("file_path", "")
                if not file_path:
                    continue

                mime_type = _guess_mime(file_path)

                r2 = await c.get(f"{FILE_BASE}/{file_path}")
                if r2.status_code != 200:
                    continue

                content = r2.content
                b64 = base64.b64encode(content).decode()
                data_url = f"data:{mime_type};base64,{b64}"

                logger.info(f"Media downloaded: {file_id} ({len(content):,} bytes, {mime_type})")
                return {
                    "data_url": data_url,
                    "data_b64": b64,
                    "mime_type": mime_type,
                    "size_bytes": len(content),
                }
        except Exception as e:
            logger.warning(f"Media download attempt {attempt+1}/{MAX_RETRIES} failed: {e}")

    return {}


async def download_and_split_video(video_file_id: str, thumb_file_id: str = None) -> dict:
    """
    Download video from Telegram, extract audio track via ffmpeg,
    and optionally download the thumbnail as image.

    Returns {
        audio: {data_url, data_b64, mime_type, size_bytes} or None,
        image: {data_url, data_b64, mime_type, size_bytes} or None,
        video: {data_url, data_b64, mime_type, size_bytes} or None,
    }
    """
    result = {"audio": None, "image": None, "video": None}

    # 1. Download thumbnail as image (fast, small)
    if thumb_file_id:
        thumb = await download_media(thumb_file_id)
        if thumb:
            result["image"] = thumb

    # 2. Download the full video
    video_data = await download_media(video_file_id)
    if not video_data:
        return result

    result["video"] = video_data

    # 3. Extract audio from video using ffmpeg
    try:
        video_bytes = base64.b64decode(video_data["data_b64"])

        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as vf:
            vf.write(video_bytes)
            video_path = vf.name

        audio_path = video_path.replace(".mp4", ".ogg")

        # ffmpeg: extract audio as OGG Opus (same format as Telegram voice notes)
        proc = subprocess.run(
            ["ffmpeg", "-i", video_path, "-vn", "-acodec", "libopus",
             "-b:a", "32k", "-y", audio_path],
            capture_output=True, timeout=30,
        )

        if proc.returncode == 0 and os.path.exists(audio_path):
            with open(audio_path, "rb") as af:
                audio_bytes = af.read()
            if len(audio_bytes) > 100:  # valid audio
                audio_b64 = base64.b64encode(audio_bytes).decode()
                result["audio"] = {
                    "data_url": f"data:audio/ogg;base64,{audio_b64}",
                    "data_b64": audio_b64,
                    "mime_type": "audio/ogg",
                    "size_bytes": len(audio_bytes),
                }
                logger.info(f"Audio extracted from video: {len(audio_bytes):,} bytes")
        else:
            logger.warning(f"ffmpeg audio extraction failed: {proc.stderr[:200] if proc.stderr else 'no output'}")

        # Cleanup temp files
        try:
            os.unlink(video_path)
        except:
            pass
        try:
            os.unlink(audio_path)
        except:
            pass

    except FileNotFoundError:
        logger.warning("ffmpeg not found - cannot extract audio from video. Install ffmpeg.")
    except subprocess.TimeoutExpired:
        logger.warning("ffmpeg timed out extracting audio")
    except Exception as e:
        logger.warning(f"Audio extraction error: {e}")

    # If no image from thumbnail, use a frame from video
    if not result["image"] and result["video"]:
        try:
            video_bytes = base64.b64decode(video_data["data_b64"])
            with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as vf:
                vf.write(video_bytes)
                video_path = vf.name
            frame_path = video_path.replace(".mp4", "_frame.jpg")

            proc = subprocess.run(
                ["ffmpeg", "-i", video_path, "-vframes", "1", "-q:v", "5", "-y", frame_path],
                capture_output=True, timeout=10,
            )
            if proc.returncode == 0 and os.path.exists(frame_path):
                with open(frame_path, "rb") as ff:
                    frame_bytes = ff.read()
                frame_b64 = base64.b64encode(frame_bytes).decode()
                result["image"] = {
                    "data_url": f"data:image/jpeg;base64,{frame_b64}",
                    "data_b64": frame_b64,
                    "mime_type": "image/jpeg",
                    "size_bytes": len(frame_bytes),
                }
                logger.info(f"Video frame extracted: {len(frame_bytes):,} bytes")
            try:
                os.unlink(video_path)
            except:
                pass
            try:
                os.unlink(frame_path)
            except:
                pass
        except Exception as e:
            logger.warning(f"Frame extraction error: {e}")

    return result


def _guess_mime(file_path: str) -> str:
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""
    mime_map = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
        "gif": "image/gif", "webp": "image/webp",
        "ogg": "audio/ogg", "oga": "audio/ogg", "mp3": "audio/mpeg",
        "wav": "audio/wav", "webm": "audio/webm",
        "mp4": "video/mp4", "mov": "video/quicktime",
    }
    return mime_map.get(ext, "application/octet-stream")
