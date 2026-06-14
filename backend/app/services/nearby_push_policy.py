"""
nearby_push_policy - Phase 4 push-notification eligibility rules.

Docs/NEARBY_REPORTS_PIPELINE.md §8. Single function that, given a
NearbyGroup, decides whether a push notification should be
DISPATCHED. The actual SW Push delivery lives in
`app/services/push.py` - this module is the policy layer between
the aggregator's signal and the delivery layer.

Hybrid policy (operator decision per docs §8.1):

  • HIGH-confidence acute (is_acute=true AND acute_grade='high') →
    immediate SW push to all admins in region + subscribed citizens
    within saved-location radius.
  • LOW-confidence acute (is_acute=true AND acute_grade='low') →
    NO push, dashboard badge only.
  • Otherwise (T3 cluster) → push to subscribed citizens within
    saved-location radius (existing channel).

Frequency caps live in settings.CRISP_PUSH_FREQUENCY_CAP_PER_USER_
PER_HOUR - enforced by the delivery layer, not here.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.services.nearby_aggregator import NearbyGroup


@dataclass
class PushDecision:
    should_push: bool
    target_audience: str   # 'admins_only' | 'admins_and_citizens' | 'citizens_only' | 'none'
    reason: str            # for telemetry + audit


def evaluate_push_eligibility(group: NearbyGroup) -> PushDecision:
    """Decide whether `group` warrants a push notification.

    Doesn't perform the push - just returns the decision so the
    caller can route it to the appropriate delivery channel.
    """
    if group.is_acute and group.acute_grade == "high":
        return PushDecision(
            should_push=True,
            target_audience="admins_and_citizens",
            reason="high_confidence_acute",
        )
    if group.is_acute:
        # LOW-confidence: badge in admin tray on next poll; no push.
        return PushDecision(
            should_push=False,
            target_audience="admins_only",
            reason="low_confidence_acute_badge_only",
        )
    if group.tier == "verified" and group.kind != "resolved_recent":
        return PushDecision(
            should_push=True,
            target_audience="citizens_only",
            reason="new_verified_cluster",
        )
    return PushDecision(
        should_push=False,
        target_audience="none",
        reason="below_push_threshold",
    )
