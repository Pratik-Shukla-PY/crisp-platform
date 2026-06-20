# Confidence Score — methodology (for review / UNDP)

The **Confidence Score** answers one question for the operator in seconds:
**"How confident is the *system* that this report is real and actionable — and why?"**

It is a single **0–100** number, computed **server-side at read time** (never stored) by
`backend/app/services/credibility.py` → `compute_incident_credibility()`, and rendered in the
dashboard's "Score composition" panel.

## Design principles

1. **Additive & fully explainable.** The score is the **sum of five independent automated checks**,
   each worth up to a fixed maximum. There is no black-box weighting — every point is attributable
   to one check and shown with its evidence. `score = Σ awarded`.
2. **System-only — human decisions never move it.** An analyst accepting, rejecting or otherwise
   reviewing a report **does not change the Confidence Score**. The human verdict is tracked
   *separately* as the report's operational status. (This deliberately reverses an earlier
   "human override" model — the score is now purely the machine's assessment, so analysts can see
   the automated signal *independently* of their own judgement.)
3. **No fabricated inputs.** A check only contributes points from data that genuinely exists. If a
   check has not run (e.g. satellite not yet fetched) it scores 0 and is shown as "not run", never a
   guessed value. The score is suppressed entirely (shown as "Not yet assessed") until at least the
   AI and/or satellite check has run.
4. **Auditable.** Each check returns `{label, max, awarded, reason}` and the UI shows the exact
   arithmetic (`+16 +4 +15 +6 +10 = 51`).

## The five checks

| # | Check | Max | What it measures | Input | **AI?** |
|---|-------|----:|------------------|-------|:------:|
| 1 | **AI content analysis** | 30 | Does the report's *content* (photo, voice transcript, description, metadata) read as a genuine, specific, internally-consistent incident? | `ai_assessment.confidence_score` (0–100) | **Yes** |
| 2 | **Satellite imagery correlation** | 25 | Does recent overhead imagery corroborate the reported location + damage? | `verification.total_score` (0–100) | **Yes** |
| 3 | **Location & metadata** | 15 | How trustworthy is the position — a precise device GPS fix vs. a coarse / text-geocoded location? | GPS `accuracy_meters`, `geocoding_confidence` | No |
| 4 | **Corroboration & duplicates** | 15 | Do independent nearby reports confirm the same event? | `duplicate_count` (corroborating reports) | No |
| 5 | **Reporter credibility** | 15 | What is the reporter's verified track record? | reporter trust tier | No |
| | **Total** | **100** | | | |

**Bands** (applied to the 0–100 total): **VERIFIED ≥ 80 · LIKELY ≥ 60 · MIXED ≥ 40 · WEAK < 40**;
`UNVERIFIED` before the assessment is run.

### 1 · AI content analysis — max 30  **(AI)**
- **Formula:** `awarded = round(30 × ai_confidence / 100)`.
- `ai_confidence` is produced by **Claude** (the `/reports/{id}/ai-assess` dossier — a text/vision
  model call over the report's description, voice transcript, photo analysis and metadata, returning
  a 0–100 confidence plus a summary/reasoning). The model is the latest Claude Sonnet.
- **This report:** AI confidence 52/100 → `30 × 0.52 = 15.6` → **+16 / 30**.

### 2 · Satellite imagery correlation — max 25  **(AI)**
- **Formula:** `awarded = round(25 × satellite_score / 100)`.
- `satellite_score` is the truth-score from `truth_scorer.py`: recent imagery is fetched from
  **non-AI providers** (AWS Sentinel-2, Microsoft Planetary Computer, ESA Copernicus, Mapbox), then
  **Claude vision** compares the citizen photo against that imagery and scores the match (location
  authenticity, damage corroboration, description coherence, data quality).
- If the satellite check could not run (no cloud-free imagery, provider error) it scores **0** and is
  flagged "could not run" — distinct from a genuinely low score.
- **This report:** satellite score 14/100 → `25 × 0.14 = 3.5` → **+4 / 25**.

### 3 · Location & metadata — max 15  **(no AI — deterministic)**
- Pure rule-based read of the report's own location fields:
  - GPS present, `accuracy ≤ 50 m` → **15** (full)
  - GPS present, `accuracy ≤ 500 m` → `15 × 0.75 = 11.25`
  - GPS present, coarser → `15 × 0.6 = 9`
  - Location only geocoded from free text (SMS/IVR) → scaled by `geocoding_confidence`
    (`15 × max(0.3, confidence)`), and capped at `15 × 0.5` when a GPS fix has low geocoding confidence.
  - No location → 0.
- **This report:** precise GPS fix (±12 m, ≤ 50) → **+15 / 15**.

### 4 · Corroboration & duplicate detection — max 15  **(no AI — count-based)**
- **Formula:** if `duplicate_count > 0` → `min(15, 6 + 3 × duplicate_count)`; if 0 → `15 × 0.4 = 6`
  (a neutral baseline — a single report is neither corroborated nor contradicted).
- `duplicate_count` comes from the duplicate-detection engine (perceptual image hash, fuzzy text
  similarity, geo-proximity and time window — **algorithmic, not an LLM**).
- **This report:** no corroborating reports nearby → baseline **+6 / 15**.

### 5 · Reporter credibility — max 15  **(no AI — deterministic)**
- **Formula:** `awarded = round(15 × tier_track_record / 100)`, where the trust tier maps to a track
  record: `T4_LIFEKEEPER 95 · T3_CHANGEMAKER 85 · T2_SIGNAL 70 · T1_SCOUT 55 · NEWCOMER 50`. The tier
  is earned from the reporter's history of verified reports (gamified incentive system, no AI).
- **This report:** tier T2_SIGNAL (70) → `15 × 0.70 = 10.5` → **+10 / 15**.

### Worked example (the screenshot)
`+16 (AI) + 4 (satellite) + 15 (location) + 6 (corroboration) + 10 (reporter) = **51 / 100 → MIXED**`.

> Rounding is round-half-to-even (banker's rounding), so `10.5 → 10` and `3.5 → 4`. Each shown point
> equals the per-check raw value rounded to the nearest whole point; the total is the sum of the
> shown points.

## Where AI is used — and where it is NOT

| Element | AI used? | What does the work |
|---|:---:|---|
| AI content analysis (max 30) | **Yes** | **Claude** (Sonnet) reads the photo/transcript/description/metadata → 0–100 confidence + reasoning |
| Satellite imagery correlation (max 25) | **Yes (vision)** | Imagery **fetched** from satellite providers (no AI); **Claude vision** scores the photo-vs-imagery match |
| Location & metadata (max 15) | **No** | Deterministic rules on GPS accuracy / geocoding confidence |
| Corroboration & duplicates (max 15) | **No** | Algorithmic dedup (perceptual hash + fuzzy text + geo/time), then a count formula |
| Reporter credibility (max 15) | **No** | Lookup of the reporter's earned trust tier (verified-report history) |
| **Final score + banding** | **No** | Pure arithmetic sum + fixed thresholds; **human verdict deliberately excluded** |

**Summary:** AI contributes to at most **55 of 100 points** (AI content 30 + satellite 25), and only
ever as a *transparent, bounded input* — Claude returns 0–100 scores that are converted to points by
fixed multipliers and shown with their evidence. The remaining **45 points** (location, corroboration,
reporter) and the entire **summation, banding and the AI↔human separation** are deterministic and
contain no AI. This satisfies the UNDP requirement that the platform is human-driven and explainable:
the machine *advises with a transparent score*; the **analyst decides** (accept / reject / respond),
and that decision is recorded separately and never alters the score.
