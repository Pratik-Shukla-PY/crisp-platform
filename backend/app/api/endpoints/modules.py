"""YAML-driven modular form framework (Apr 2026 UI v2.1 W6).

UNDP brief (§The Challenge): "while the core use case for the app is
to augment and improve crisis assessment and response, it is desirable
that your app also supports the ability to ask specific, modular
questions to specific communities: for instance, to ask about the
impact on livelihoods in the months after a crisis."

KoBoToolbox owns the "modular forms" differentiation axis today; this
module closes the gap by letting field operators drop a YAML module
into `backend/app/modules/` and have both PWA + RN pickers render it
without a code change. The endpoint returns JSON - the client
translators (`t()`) and renderers don't need to know YAML.

Endpoints:

    GET /api/v1/modules
        Returns every module definition. Clients filter client-side by
        crisis_type / infrastructure_type / time-since-report using
        the `applies_to` block on each module.

    GET /api/v1/modules/{module_id}
        Single module - small-response path for when a client already
        knows which module it wants.

    GET /api/v1/modules/applicable?crisis_type=FLOOD&…
        Convenience filter - server-side evaluates `applies_to` so
        clients that can't (or don't want to) implement the matcher
        get a ready-to-render list.

Security: read-only, unauthenticated. Module definitions are contract,
not secret - the evaluator should be able to `curl` the endpoint and
see every module CRISP ships.
"""
from __future__ import annotations
import logging
import os
from functools import lru_cache
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, HTTPException, Query

logger = logging.getLogger(__name__)
router = APIRouter()


# Directory resolution: `backend/app/modules/*.yaml` - co-located with
# the code for now so it ships with the Docker image. Operators can
# override via `CRISP_MODULES_DIR` env var for out-of-tree authoring.
def _modules_dir() -> str:
    env = os.environ.get("CRISP_MODULES_DIR")
    if env:
        return env
    here = os.path.dirname(__file__)
    return os.path.abspath(os.path.join(here, "..", "..", "modules"))


def _validate_module(mod: Dict[str, Any], file_name: str) -> None:
    """Cheap shape check. Loud on malformed - operators should notice
    at load-time, not once a field engineer discovers a broken form."""
    required = ["id", "version", "title", "fields"]
    for r in required:
        if r not in mod:
            raise ValueError(f"{file_name}: missing top-level key `{r}`")
    if not isinstance(mod["fields"], list) or not mod["fields"]:
        raise ValueError(f"{file_name}: `fields` must be a non-empty list")
    valid_types = {"single_select", "multi_select", "short_text",
                   "long_text", "integer", "yes_no"}
    for idx, f in enumerate(mod["fields"]):
        if "key" not in f or "type" not in f:
            raise ValueError(f"{file_name} field #{idx}: key + type required")
        if f["type"] not in valid_types:
            raise ValueError(
                f"{file_name} field `{f['key']}`: unknown type `{f['type']}` "
                f"(allowed: {sorted(valid_types)})"
            )


@lru_cache(maxsize=1)
def _load_all() -> List[Dict[str, Any]]:
    """Load + validate every YAML file in the modules dir. Cached so the
    disk-read only happens once per process; call `_load_all.cache_clear()`
    from a hot-reload handler if you add that later."""
    d = _modules_dir()
    if not os.path.isdir(d):
        logger.warning("[modules] directory missing: %s - returning []", d)
        return []
    out: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(d)):
        if not name.endswith((".yaml", ".yml")):
            continue
        path = os.path.join(d, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                mod = yaml.safe_load(f) or {}
            _validate_module(mod, name)
            out.append(mod)
        except Exception as e:
            logger.error("[modules] %s: load failed: %s", name, e)
            # Never raise at import-time - module failures shouldn't take
            # the whole API down. Operator gets the error via the log.
            continue
    logger.info("[modules] loaded %d module(s) from %s", len(out), d)
    return out


def _applies(mod: Dict[str, Any], *,
             crisis_type: Optional[str] = None,
             infrastructure_type: Optional[str] = None) -> bool:
    """Server-side evaluator for the `applies_to` block. Missing /
    empty lists mean "match any"; a non-empty list means "must be in".
    Case-insensitive to be kind to clients that stringify enums."""
    rules = mod.get("applies_to") or {}
    cts = rules.get("crisis_types") or []
    its = rules.get("infrastructure_types") or []
    if cts and crisis_type and crisis_type.upper() not in [c.upper() for c in cts]:
        return False
    if its and infrastructure_type and infrastructure_type.upper() not in [i.upper() for i in its]:
        return False
    return True


@router.get(
    "",
    summary="List every module definition",
    description=(
        "Returns the full set of modular forms CRISP ships. Each entry "
        "carries a top-level `id`, `version`, `title` (+ i18n key), "
        "`description`, an `applies_to` gating block, and a `fields` "
        "array. Client rendering is driven entirely by the JSON - "
        "drop a new YAML file in `backend/app/modules/` and it appears "
        "in the next response."
    ),
)
def list_modules():
    return {
        "count": len(_load_all()),
        "modules": _load_all(),
    }


@router.get(
    "/applicable",
    summary="Modules applicable to a given crisis / infra context",
    description=(
        "Server-side filter on the `applies_to` block of every module. "
        "Handy for capture clients that don't want to implement the "
        "matcher themselves. Unknown params are ignored, not rejected."
    ),
)
def applicable_modules(
    crisis_type: Optional[str] = Query(None),
    infrastructure_type: Optional[str] = Query(None),
):
    matched = [
        m for m in _load_all()
        if _applies(m, crisis_type=crisis_type,
                     infrastructure_type=infrastructure_type)
    ]
    return {
        "count": len(matched),
        "filters": {
            "crisis_type": crisis_type,
            "infrastructure_type": infrastructure_type,
        },
        "modules": matched,
    }


@router.get(
    "/{module_id}",
    summary="Single module by id",
)
def get_module(module_id: str):
    for m in _load_all():
        if m.get("id") == module_id:
            return m
    raise HTTPException(status_code=404, detail=f"Module {module_id} not found")
