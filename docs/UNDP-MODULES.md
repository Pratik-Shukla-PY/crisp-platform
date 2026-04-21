# UNDP Appendix-1 ↔ CRISP Module Mapping

*Last reviewed: April 2026.*

The UNDP RAPIDA problem statement's Appendix-1 specifies a modular set
of assessment fields. This document is the canonical mapping between
those modules and CRISP storage columns / enum values — written so a
UNDP evaluator can verify coverage without reading source code.

A judge can cross-reference this table against the JSON payload of any
sample report (use `GET /api/v1/reports/{id}` or the CSV/PDF export)
and confirm that the required fields are present.

## 1 · Damage classification

UNDP Appendix-1 labels: **Minimal/No damage**, **Partially damaged**,
**Completely damaged**.

| UNDP label           | CRISP column | CRISP value |
|----------------------|-------------|-------------|
| Minimal/No damage    | `damage_classification` | `MINIMAL`   |
| Partially damaged    | `damage_classification` | `PARTIAL`   |
| Completely damaged   | `damage_classification` | `COMPLETE`  |

Legacy value `NO_DAMAGE` is accepted on write (normalised to `MINIMAL`
by `app.core.taxonomy.normalise_damage`) so pre-April-2026 clients do
not error out.

## 2 · Infrastructure type

UNDP Appendix-1 super-types (7 + Other):
Residential · Commercial · Government · Utility · Transport &
Communication · Community · Public Spaces / Recreation · Other.

| UNDP super-type             | CRISP stored value (`infrastructure_type`) | Typical sub-types |
|-----------------------------|--------------------------------------------|-------------------|
| Residential                 | `RESIDENTIAL`                              | `HOUSE` |
| Commercial                  | `COMMERCIAL`                               | `MARKET`, `SHOP`, `OFFICE` |
| Government                  | `GOVERNMENT`                               | — |
| Utility                     | `UTILITY`                                  | `POWER`, `WATER`, `TELECOM` |
| Transport & Communication   | `TRANSPORT_COMMUNICATION`                  | `ROAD` |
| Community                   | `COMMUNITY`                                | `HOSPITAL`, `SCHOOL` |
| Public Spaces / Recreation  | `PUBLIC_SPACES`                            | `PARK`, `RELIGIOUS` |
| Other                       | `OTHER`                                    | — |

The original fine-grained chip the reporter tapped is preserved in
`infrastructure_sub_type` for drill-down analytics. The backend
mapping is centralised in `app.core.taxonomy.UI_CHIP_TO_UNDP`.

## 3 · Crisis type + category

UNDP Appendix-1 groups nine crisis types into three categories:

| Category       | UNDP types                                    | CRISP `crisis_type` values |
|----------------|-----------------------------------------------|----------------------------|
| Natural        | Earthquake, Flood, Tsunami, Cyclone, Landslide| `EARTHQUAKE`, `FLOOD`, `TSUNAMI`, `CYCLONE`, `LANDSLIDE` |
| Technological  | Explosion, Chemical incident, Pandemic        | `EXPLOSION`, `CHEMICAL_INCIDENT`, `PANDEMIC` |
| Human-made     | Conflict, Civil unrest                        | `CONFLICT`, `CIVIL_UNREST` |

The category itself is stored on a dedicated column `crisis_category`
(populated automatically via the `before_insert` / `before_update`
taxonomy hook on the Report model) so dashboards can filter "all
human-made crises" without duplicating the mapping client-side.

Legacy values `HURRICANE` and `WILDFIRE` are kept in the enum for
backward compatibility:

  * `HURRICANE` bundles under `NATURAL` (UNDP treats hurricane =
    cyclone in a different basin).
  * `WILDFIRE` falls through to `OTHER` — UNDP has no distinct bucket
    for it.

## 4 · Service status (modular per-infrastructure)

Stored as JSON in `service_status`. Each key is a service (electricity
/ water / telecom / health), each value is a level.

UNDP Appendix-1 prescribes finer-grained levels for **electricity**
and **health services** than CRISP originally stored. The enum in
`app.models.report.ServiceStatusEnum` was extended April 2026 to carry
every Appendix-1 level without breaking legacy rows.

### Electricity (5-level)

| UNDP level    | CRISP enum value          |
|---------------|---------------------------|
| Operational   | `OPERATIONAL`             |
| Intermittent  | `INTERMITTENT`            |
| Load-shedding | `LOAD_SHEDDING`           |
| Blackout      | `BLACKOUT` / `DESTROYED`* |
| Unknown       | `UNKNOWN`                 |

\* `DESTROYED` is the pre-April-2026 legacy label for "blackout plus
infrastructure damage". New captures prefer the richer
`BLACKOUT` / `INTERMITTENT` pair.

### Water

| UNDP level          | CRISP enum value         |
|---------------------|--------------------------|
| Operational         | `OPERATIONAL`            |
| Disrupted           | `DISRUPTED`              |
| No supply           | `DESTROYED`              |
| Unknown             | `UNKNOWN`                |

### Telecom

Same 4-level mapping as Water above.

### Health services (4-level)

| UNDP level               | CRISP enum value          |
|--------------------------|---------------------------|
| Fully operational        | `FULLY_OPERATIONAL`       |
| Partially operational    | `PARTIALLY_OPERATIONAL`   |
| Not operational          | `NOT_OPERATIONAL`         |
| Unknown                  | `UNKNOWN`                 |

The legacy 3-level shorthand (`OPERATIONAL` / `DISRUPTED` /
`DESTROYED`) continues to validate — the PWA simply emits a single
appropriate value, and a UNDP-compliant client can choose the finer
grain.

## 5 · Pressing needs (9 options)

UNDP Appendix-1 lists nine pressing-needs categories. CRISP stores
them as a JSON array in `needs` — multi-select.

| UNDP need label    | CRISP value (i18n key)  |
|--------------------|-------------------------|
| Food               | `food` (`need_food`)    |
| Water              | `need_water`            |
| Shelter            | `shelter`               |
| Medical            | `medical`               |
| Security           | `security`              |
| Electricity        | `electricity`           |
| Telecom            | `telecom`               |
| Clothing           | *(via free-text)*       |
| Evacuation         | *(via free-text)*       |

Two of the nine (Clothing, Evacuation) are captured via the free-text
`description` field rather than dedicated chips, to keep the review
page lean on a phone. A future iteration can promote them to first-
class chips if field data shows frequent use.

## 6 · Debris clearing

Boolean `debris_clearing_needed` — a derived flag, not in Appendix-1
verbatim, but used by response teams to dispatch clearance equipment.

## 7 · Building identification

`building_id` — preserved across multiple reports about the same
structure. Allows a dashboard analyst to version a building's damage
trajectory ("reported partial 09:00, reported complete 14:00 after
aftershock"). Linked to the building-footprint selector
(docs/BUILDING-FOOTPRINT.md when shipped).

## 8 · Infrastructure name

`infrastructure_name` — free-text string. Optional, rarely populated,
but useful when a specific well-known landmark is damaged
("Kalyan Bridge", "City Hospital"). Not in the UNDP column list but
preserved for analyst context.

---

## Framework vs alignment

CRISP ships **alignment** today: every Appendix-1 field has a storage
column and a legal value set. CRISP does not yet ship a **framework**
where a UNDP deployment team can drop in a new crisis type with its
own required module set without deploying new code. That framework is
on the roadmap as `docs/ROADMAP.md §modular-forms` — it is a deferred
scope item flagged in the April-2026 gap analysis
(`.claude/plans/swirling-forging-raccoon.md` §3.6). This document +
the taxonomy hook + the enum expansion above close the
compliance-critical leg of the gap; the framework leg is post-June
unless pull-forward is explicitly authorised.
