"""
SMS Text Parser — Extracts incident type, severity, and location from raw SMS text.
Uses keyword matching (MVP) with NLP-ready structure for future upgrade.
"""
import re
import logging

logger = logging.getLogger(__name__)

# Incident type keywords → CRISP infrastructure_type
_TYPE_KEYWORDS = {
    "WATER": ["flood", "water", "rain", "overflow", "dam", "river", "pipeline", "burst", "leak", "drain", "sewage", "tsunami", "cyclone"],
    "ROAD": ["road", "bridge", "highway", "collapse", "crack", "pothole", "traffic", "landslide", "blocked", "debris"],
    "HOSPITAL": ["hospital", "clinic", "medical", "injury", "injured", "ambulance", "doctor", "patient", "health"],
    "HOUSE": ["house", "home", "building", "shelter", "roof", "wall", "stuck", "trapped", "rescue", "evacuate"],
    "POWER": ["power", "electric", "electricity", "blackout", "wire", "pole", "transformer", "outage", "generator"],
    "OTHER": ["fire", "smoke", "explosion", "gas", "chemical", "earthquake", "quake"],
}

# Severity keywords
_SEVERITY_HIGH = ["urgent", "emergency", "critical", "dying", "dead", "death", "severe", "major", "rescue", "sos", "help me", "save", "trapped", "stuck", "dangerous"]
_SEVERITY_MED = ["need help", "damage", "broken", "problem", "affected", "bad"]
_SEVERITY_LOW = ["minor", "small", "little", "slight"]

# Crisis type keywords → UNDP required
_CRISIS_KEYWORDS = {
    "EARTHQUAKE": ["earthquake", "quake", "tremor", "seismic", "aftershock"],
    "FLOOD": ["flood", "flooding", "inundation", "overflow", "tsunami", "tidal"],
    "CONFLICT": ["conflict", "war", "attack", "bomb", "explosion", "shelling", "gunfire", "airstrike"],
    "HURRICANE": ["hurricane", "typhoon", "storm", "cyclone"],
    "WILDFIRE": ["wildfire", "fire", "bushfire", "forest fire", "blaze"],
    "LANDSLIDE": ["landslide", "mudslide", "rockfall", "avalanche"],
    "PANDEMIC": ["pandemic", "epidemic", "outbreak", "virus", "covid", "cholera"],
}

# Damage classification keywords
_DAMAGE_KEYWORDS = {
    "COMPLETE": ["destroyed", "collapsed", "demolished", "flattened", "total", "rubble", "gone"],
    "PARTIAL": ["damaged", "broken", "cracked", "leaking", "partial", "bent", "tilted"],
    "NO_DAMAGE": ["safe", "intact", "undamaged", "fine", "ok", "standing"],
}

# Debris-clearing keywords — UNDP core question "Is there debris that requires
# clearing on or near the infrastructure site?". A POSITIVE signal sets
# debris_clearing_needed=True. There is no reliable NEGATIVE signal in free
# SMS text (absence of the word != "no debris"), so a no-match yields None
# (unknown) rather than False — the never-invent-a-value invariant the rest of
# the parser follows for damage_classification.
_DEBRIS_KEYWORDS = [
    "debris", "rubble", "wreckage", "blocked", "blocking", "blockage",
    "obstruct", "obstructed", "obstructing", "clear the road", "road clear",
    "clearing", "fallen tree", "fallen pole", "collapsed onto", "buried",
    "impassable", "cannot pass", "can't pass", "path blocked", "access blocked",
]


def parse_sms(text: str) -> dict:
    """
    Parse raw SMS text into structured incident data.

    Returns:
        {
            "infrastructure_type": "WATER" | "ROAD" | ... | "OTHER",
            "severity": "SEVERE" | "MODERATE" | "MINOR",
            "description": str (cleaned text),
            "location_text": str (extracted location phrase or full text),
            "keywords_found": list[str],
        }
    """
    if not text or not text.strip():
        return {"infrastructure_type": "OTHER", "severity": "MODERATE", "description": "", "location_text": "", "keywords_found": []}

    lower = text.lower().strip()
    keywords_found = []

    # 1. Detect infrastructure type
    infra_type = "OTHER"
    best_count = 0
    for itype, keywords in _TYPE_KEYWORDS.items():
        count = sum(1 for k in keywords if k in lower)
        if count > best_count:
            best_count = count
            infra_type = itype
            keywords_found.extend([k for k in keywords if k in lower])

    # 2. Detect severity
    severity = "MODERATE"  # default
    if any(k in lower for k in _SEVERITY_HIGH):
        severity = "SEVERE"
        keywords_found.extend([k for k in _SEVERITY_HIGH if k in lower])
    elif any(k in lower for k in _SEVERITY_LOW):
        severity = "MINOR"
    elif any(k in lower for k in _SEVERITY_MED):
        severity = "MODERATE"

    # 3. Extract location — look for "in/at/near" + place name patterns
    location_text = ""
    loc_patterns = [
        r'(?:in|at|near|from|around)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)',  # "near Sector 7"
        r'(?:village|town|city|area|district|block|sector|colony|nagar|puram|pur|ganj|wadi|palli)\s*[\-:]?\s*(\S+(?:\s+\S+){0,3})',
    ]
    for pattern in loc_patterns:
        m = re.search(pattern, text)
        if m:
            location_text = m.group(1).strip()
            break

    # If no location pattern found, use the full text for geocoding
    if not location_text:
        location_text = text.strip()

    # 4. Detect crisis type
    crisis_type = "OTHER"
    best_crisis = 0
    for ctype, keywords in _CRISIS_KEYWORDS.items():
        count = sum(1 for k in keywords if k in lower)
        if count > best_crisis:
            best_crisis = count
            crisis_type = ctype

    # 5. Detect damage classification
    damage_class = ""
    for dclass, keywords in _DAMAGE_KEYWORDS.items():
        if any(k in lower for k in keywords):
            damage_class = dclass
            break

    # 6. Detect debris-clearing need (UNDP core question). Positive signal
    # only → True; otherwise None (unknown). Never default to False.
    debris_clearing_needed = True if any(k in lower for k in _DEBRIS_KEYWORDS) else None

    logger.info(
        f"SMS parsed: type={infra_type} sev={severity} crisis={crisis_type} "
        f"damage={damage_class} debris={debris_clearing_needed} loc='{location_text[:30]}'"
    )

    return {
        "infrastructure_type": infra_type,
        "severity": severity,
        "crisis_type": crisis_type,
        "damage_classification": damage_class,
        "debris_clearing_needed": debris_clearing_needed,
        "description": text.strip(),
        "location_text": location_text,
        "keywords_found": list(set(keywords_found)),
    }
