# Crisis Forms → Credibility Chain

How a Dynamic Crisis Form's curated answers flow from capture all the way into
the AI credibility score. This is the reviewable "chain of events" for the
geo-gated crisis-pack feature: every link is additive, and the default report
flow (no active pack) is byte-identical at every step.

## The chain

```
1. ACTIVATE   Admin creates a CrisisEvent (zone center+radius+time window) and
              binds a published CrisisFormPack.
              dashboard: web-dashboard/src/cc-crisis.js
              api:       POST /api/v1/admin/crisis-forms/{events,packs}

2. GEO-GATE   On the reporter's location fix the client calls
              GET /api/v1/crisis-forms/active?lat&lng (server-side haversine).
              In-zone → the pack is returned; out-of-zone / expired → {}.
              PWA: mobile-app/src/v4-flow.js::_maybeFetchCrisisPack

3. CAPTURE    Inside an active zone the PWA renders the pack's extra questions
              after the hardcoded chips (and skips the redundant "what caused
              it?" step — the event already fixes the crisis type). The canonical
              chips still populate the first-class columns (parity, must-have #1).

4. SUBMIT     At submit, form_data = {stock pack answers} ∪ {maps_to fields
              sourced from canonical state}; form_pack_id + form_pack_version ride
              along. The server re-validates form_data against the captured pack
              version before persisting.
              Report.form_data / .form_pack_id / .form_pack_version / .crisis_event_id
              (backend/app/models/report.py:425-427)

5. DISPLAY    The dashboard report-detail renders form_data as a "Crisis-pack
              answers" section + a crisis-form tag (pack title + event name).
              web-dashboard/src/app.js (_renderFormDataSection, dp-form-tag)

6. VERIFY     POST /api/v1/reports/{id}/verify fetches satellite imagery and runs
              truth_scorer.score(...). As of B4 it also passes the report's
              form_data + crisis_type + form_pack_id/version into the scorer.
              backend/app/api/endpoints/reports.py::verify_report

7. CREDIBILITY truth_scorer injects the curated answers into the Claude prompt as
              "COMMUNITY-CURATED GROUND TRUTH" and instructs the rubric to weigh
              them across components 2 (damage corroboration), 3 (description
              coherence) and 4 (data quality, +3 pts capped at 25). The result
              carries form_data_considered + an appended key-finding so the
              dashboard verdict panel shows the curated answers were weighed.
              backend/app/services/truth_scorer.py::score / _format_curated_answers
```

## Why this improves the analysis ("change of parameters")

A default report gives the scorer three signals: the photo, the satellite tile,
and free text. A crisis-pack report adds **structured, constrained answers to
crisis-specific questions** ("flames visible? yes", "water depth: knee-high").
These are higher-signal than free text because they are bounded and event-scoped.
Feeding them into the credibility chain means:

- **Corroboration, not substitution.** Curated answers strengthen (or, if they
  contradict the photo/satellite, weaken) the assessment. They never replace
  visual confirmation — the prompt says so explicitly.
- **The whole chain is considered.** crisis_type is event-confirmed (not just a
  reporter claim), so the scorer treats the infrastructure/damage claims in the
  context of a known event type.
- **Auditability.** form_data_considered + the key-finding make it explicit, on
  every verified report, whether community ground truth was part of the score.

## Safety / regression properties

- **Backward-compatible signature.** `score()` gained four keyword args, all
  defaulting to `None`. Every existing caller is unaffected; a default-flow
  report (form_data NULL) produces a byte-identical prompt and score.
- **No schema/migration change.** `form_data_considered` rides the existing
  result dict + the appended `key_findings` entry (already persisted on
  `SatelliteVerification`). Nothing new on the table.
- **Capped influence.** The data-quality bump is hard-capped at the existing
  25-pt component ceiling, so curated answers cannot inflate a score past the
  rubric's bounds.
