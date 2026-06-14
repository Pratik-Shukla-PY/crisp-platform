# CRISP Non-Monetary Engagement Incentives

**Policy document - April 2026.** Supersedes any prior badge copy in the
codebase. When the PWA, RN app, or dashboard surfaces anything
incentive-shaped, the behaviour MUST match this document.

## The UNDP requirement (verbatim)

From the RAPIDA Problem Statement (*Appendix - Engagement Incentives*):

> "Participants shall propose a non-monetary rewarding system that
> prevents users from repeating their reports or over-reporting for a
> reward."

The operative phrase is *prevents users from repeating their reports
or over-reporting for a reward*. A rewarding system keyed off raw
submission volume inverts this - it literally rewards the behaviour
UNDP is asking us to discourage. Any historical CRISP UI that did so
(the pre-April-2026 NEWCOMER → HELPER → GUARDIAN → HERO ladder) was
out of compliance.

## CRISP design principles

1. **Reward verified impact, not volume.** Every incentive surface
   (badge, headline metric, "My Reports" card) must be computed from
   reports an analyst has *accepted and dispatched / resolved* - not
   from raw submissions. Volume metrics are allowed internally for
   fraud detection but must not be visible to the reporter as a
   goal-shaped number.
2. **Cap the headline at quality.** The home-screen stat in the hero
   block is "Reports Verified", not "Reports Submitted". A user who
   drops 50 low-quality reports in an hour sees zero progress on the
   visible stat; a user with one verified report sees "1 verified".
3. **No perverse leaderboards.** There is no public ranking of
   reporters by count. The badge is a private visual on the "My
   Reports" screen and is driven exclusively by `verified_count`.
4. **Neutral fraud handling.** Flagged / duplicate / rejected reports
   do not reduce a user's badge - they just fail to earn verification.
   This prevents a "reject to punish" dynamic that could be gamed in
   the opposite direction.
5. **Crisis-agnostic categories.** Where we do want to recognise
   distinct contributions (e.g. "first responder in District X",
   "multi-lingual reporter"), recognition is categorical - not
   competitive. Two users can both be "multi-lingual"; there's no
   top-10 list.

## Implementation map (what code backs this doc)

| Concern | File | Function / DOM |
|---|---|---|
| Badge ladder (backend) | `backend/app/api/endpoints/reports.py` | `_recompute_badge_from_verified` |
| Verified-count bump | `backend/app/api/endpoints/reports.py` | `_mark_report_verified_for_credibility` |
| Triggered at dispatch | `backend/app/api/endpoints/reports.py` | `dispatch_team`, `resolve_report` |
| Headline home metric | `mobile-app/src/index.html` | `#home-impact .hi-cell + data-i18n=home_metric_verified` |
| PWA fetch + render | `mobile-app/src/app.js` | `updateHomeImpactMetrics()` |
| Test coverage | `backend/tests/test_reporter_profile_counter.py` | `TestUNDPQualityBasedCredibility` |

## Badge ladder (April 2026)

| Badge | Trigger | Visible where |
|---|---|---|
| NEWCOMER | default | "My Reports" screen |
| CONTRIBUTOR | ≥ 3 verified reports | "My Reports" screen |
| TRUSTED | ≥ 10 verified reports | "My Reports" screen |

`verified_count` is bumped once per report, the first time the report
transitions from PENDING to VERIFIED / RESPONDING / RESOLVED. Further
status moves (RESPONDING → RESOLVED) do not double-count.

## Categorical recognitions (planned - v2)

Following the "crisis-agnostic categories" principle, post-launch we
intend to add small badge-like recognitions that are descriptive, not
ranked:

* **First responder in &lt;region&gt;** - earliest verified report for a
  newly-opened crisis region.
* **Multi-lingual reporter** - ≥ 3 verified reports in 2+ languages.
* **Infrastructure expert** - ≥ 5 verified reports in one of the 7
  UNDP super-types.

Each of these is a flag, not a rank. They appear alongside the badge
in the "My Reports" screen and are additive (a user can hold multiple
simultaneously). They do not appear in any public ranking.

## What CRISP deliberately does NOT do

* No public leaderboard of reporter counts.
* No "streak" or "daily login" mechanic.
* No points-for-photos or points-for-voice.
* No monetary or voucher rewards tied to submission count.
* No notification push that says "submit more to unlock X".

## Testing

`backend/tests/test_reporter_profile_counter.py::TestUNDPQualityBasedCredibility`
pins down the invariants:

* Volume alone never upgrades a badge.
* Dispatch promotes a PENDING report to verified count.
* 3 verified reports → CONTRIBUTOR.
* Dispatch + resolve do not double-count.

Any future change to the incentive surface must add a corresponding
test in that class and update this document.

## Audit trail

This policy was introduced in the April-2026 UNDP-alignment sprint.
Before April 2026, CRISP's badge ladder was keyed off
`ReporterProfile.report_count` (raw volume). The gap analysis at
the design plan §3.8 captured the
compliance risk. This document + the code change in
`_update_reporter_profile` close that gap.
