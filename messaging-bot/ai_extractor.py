"""
AI Extractor — Uses Claude to extract structured incident data from
unstructured text (SMS, IVR transcription, user descriptions).

Extracts: location name, infrastructure type, severity, and key details.
Then geocodes the location and updates the report on the backend.
"""
import os
import json
import logging
import httpx

logger = logging.getLogger(__name__)

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
BACKEND_URL = os.getenv("CRISP_BACKEND_URL", "http://localhost:8000")


async def extract_and_update_report(report_id: str, text: str):
    """
    Use Claude to extract location, type, severity from transcription/description,
    then geocode the location and update the report.
    """
    if not text or len(text.strip()) < 10:
        return

    if not ANTHROPIC_API_KEY:
        logger.warning("ANTHROPIC_API_KEY not set — skipping AI extraction")
        # Fall back to keyword-based extraction
        await _keyword_extract_and_update(report_id, text)
        return

    try:
        # Call Claude to extract structured data
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": "claude-haiku-4-5-20251001",
                    "max_tokens": 500,
                    "messages": [{"role": "user", "content": f"""You are an AI assistant for a crisis response platform (CRISP). Extract incident information from this crisis report text. The text may be a rough machine transcription from voice (possibly translated from Hindi/regional languages to English). Clean up the language and infer the correct meaning.

Return ONLY valid JSON, no other text.

Text: "{text}"

Return JSON with these fields:
{{
  "location_name": "specific place name mentioned (city, area, landmark) or empty string",
  "infrastructure_type": "one of: WATER, ROAD, HOSPITAL, HOUSE, POWER, SCHOOL, TELECOM, GOVERNMENT, OTHER",
  "severity": "one of: SEVERE, MODERATE, MINOR",
  "crisis_type": "one of: EARTHQUAKE, FLOOD, CONFLICT, HURRICANE, CYCLONE, WILDFIRE, LANDSLIDE, PANDEMIC, OTHER",
  "damage_classification": "one of: NO_DAMAGE, PARTIAL, COMPLETE",
  "summary": "A clear, professional 1-2 sentence English summary of the crisis situation for a control center operator to take action on. Fix any transcription errors, grammar issues, and translate any non-English fragments to English. Max 80 words.",
  "user_said": "A clean English version of what the caller actually said, fixing transcription artifacts but preserving their meaning faithfully. Max 60 words."
}}"""}],
                },
            )

            if r.status_code == 200:
                result = r.json()
                ai_text = result.get("content", [{}])[0].get("text", "")
                # Parse JSON from response
                try:
                    # Handle markdown code blocks
                    if "```" in ai_text:
                        ai_text = ai_text.split("```")[1]
                        if ai_text.startswith("json"):
                            ai_text = ai_text[4:]
                    extracted = json.loads(ai_text.strip())
                    logger.info(f"AI extracted: {extracted}")
                    await _apply_extraction(report_id, extracted, text)
                    return
                except json.JSONDecodeError:
                    logger.warning(f"AI returned non-JSON: {ai_text[:100]}")
            else:
                logger.warning(f"Claude API error ({r.status_code}): {r.text[:100]}")

    except Exception as e:
        logger.warning(f"AI extraction error: {e}")

    # Fallback to keyword extraction
    await _keyword_extract_and_update(report_id, text)


async def _apply_extraction(report_id: str, extracted: dict, original_text: str):
    """Apply AI-extracted data to the report — geocode location, update classification, store AI summary."""
    from messaging_bot.sms.geocoder import geocode_text

    location_name = extracted.get("location_name", "")
    infra_type = extracted.get("infrastructure_type", "OTHER")
    severity = extracted.get("severity", "MODERATE")
    summary = extracted.get("summary", "")
    user_said = extracted.get("user_said", "")

    # Validate infrastructure type
    valid_types = ["WATER", "ROAD", "HOSPITAL", "HOUSE", "POWER", "SCHOOL", "TELECOM", "GOVERNMENT", "OTHER"]
    if infra_type not in valid_types:
        infra_type = "OTHER"

    valid_sev = ["SEVERE", "MODERATE", "MINOR"]
    if severity not in valid_sev:
        severity = "MODERATE"

    crisis_type = extracted.get("crisis_type", "OTHER")
    valid_crisis = ["EARTHQUAKE", "FLOOD", "CONFLICT", "HURRICANE", "CYCLONE", "WILDFIRE", "LANDSLIDE", "PANDEMIC", "OTHER"]
    if crisis_type not in valid_crisis:
        crisis_type = "OTHER"

    damage_class = extracted.get("damage_classification", "")
    valid_damage = ["NO_DAMAGE", "PARTIAL", "COMPLETE"]
    if damage_class not in valid_damage:
        damage_class = ""

    # Update classification — keep raw transcription in description for audit trail
    update_payload = {
        "infrastructure_type": infra_type,
        "severity": severity,
        "crisis_type": crisis_type,
        "damage_classification": damage_class if damage_class else None,
    }
    # Use the clean user_said as description (what user actually meant)
    if user_said:
        update_payload["description"] = user_said
    elif summary:
        update_payload["description"] = summary

    try:
        async with httpx.AsyncClient(timeout=15) as c:
            await c.patch(f"{BACKEND_URL}/api/v1/reports/{report_id}/classify", json=update_payload)
            logger.info(f"Report {report_id} classified by AI: type={infra_type} sev={severity}")
    except Exception as e:
        logger.warning(f"Classification update error: {e}")

    # Store AI summary in ai_analysis table
    if summary:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                await c.patch(
                    f"{BACKEND_URL}/api/v1/reports/{report_id}/ai-summary",
                    json={
                        "ai_summary": summary,
                        "transcription": original_text,  # raw Whisper output preserved
                    },
                )
                logger.info(f"Report {report_id} AI summary stored")
        except Exception as e:
            logger.warning(f"AI summary update error: {e}")

    # Geocode the location
    if location_name:
        geo = await geocode_text(location_name)
        if geo.get("latitude"):
            # We need to update location — use a direct DB approach or create the location
            # Since the report may not have a location yet, we update via description endpoint
            # which triggers the backend to store it
            logger.info(f"AI geocoded '{location_name}' → {geo['latitude']:.4f},{geo['longitude']:.4f} ({geo.get('location_name','')})")

            # Update location via a PATCH to the backend
            try:
                async with httpx.AsyncClient(timeout=15) as c:
                    loc_data = {
                        "latitude": geo["latitude"],
                        "longitude": geo["longitude"],
                        "device_latitude": geo["latitude"],
                        "device_longitude": geo["longitude"],
                        "accuracy_meters": 3000.0,
                        "device_location_name": geo.get("location_name", location_name),
                    }
                    await c.patch(
                        f"{BACKEND_URL}/api/v1/reports/{report_id}/location",
                        json=loc_data,
                    )
                    logger.info(f"Report {report_id} location updated: {geo.get('location_name', location_name)}")
            except Exception as e:
                logger.warning(f"Location update error: {e}")


async def _keyword_extract_and_update(report_id: str, text: str):
    """Fallback: keyword-based extraction when Claude is unavailable."""
    from messaging_bot.sms.parser import parse_sms
    from messaging_bot.sms.geocoder import geocode_text

    parsed = parse_sms(text)
    geo = await geocode_text(parsed["location_text"])

    update_payload = {}
    if parsed["infrastructure_type"] != "OTHER":
        update_payload["infrastructure_type"] = parsed["infrastructure_type"]
    if parsed["severity"] != "MODERATE":
        update_payload["severity"] = parsed["severity"]

    if update_payload:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                await c.patch(f"{BACKEND_URL}/api/v1/reports/{report_id}/classify", json=update_payload)
        except:
            pass

    if geo.get("latitude"):
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                await c.patch(f"{BACKEND_URL}/api/v1/reports/{report_id}/location", json={
                    "latitude": geo["latitude"], "longitude": geo["longitude"],
                    "device_latitude": geo["latitude"], "device_longitude": geo["longitude"],
                    "accuracy_meters": 5000.0,
                    "device_location_name": geo.get("location_name", ""),
                })
        except:
            pass

    logger.info(f"Keyword extraction for {report_id}: type={parsed['infrastructure_type']} loc={geo.get('location_name','none')}")
