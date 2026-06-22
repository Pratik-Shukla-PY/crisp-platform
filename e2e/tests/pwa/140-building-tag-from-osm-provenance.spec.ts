/**
 * PWA — building-tag OSM provenance survives to the submit payload (v357).
 *
 * Regression guard for the "Unnamed Building" bug: an explicit OSM footprint tap set
 * the camelCase `state.infraNameFromOsm` flag, but the submit payload read the
 * snake_case `state.infrastructure_name_from_osm` (initialised to literal `false`) via
 * `??`, which never fell through — so an explicit "University" tag shipped from_osm=false
 * and rendered as "Unnamed Building". These static guards lock the two source-level
 * fixes so the camelCase/snake_case desync cannot silently return; the observable
 * dashboard contract is covered by dashboard/68-building-name-consistency.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..', '..', '..', 'mobile-app', 'src');
const appJs = readFileSync(join(SRC, 'app.js'), 'utf8');
const buildingSelectJs = readFileSync(join(SRC, 'building-select.js'), 'utf8');

test.describe('PWA — OSM building-tag provenance reaches the payload (v357)', () => {
    test('submit payload merges the from_osm flag with || (truthy from EITHER field), never ??', async () => {
        // The fix: take the flag from whichever of the snake_case / legacy camelCase
        // fields is truthy. `??` anchored on the never-updated literal `false`.
        expect(appJs).toContain('state.infrastructure_name_from_osm || state.infraNameFromOsm');
        expect(appJs).not.toContain('state.infrastructure_name_from_osm ?? state.infraNameFromOsm');
    });

    test('an OSM footprint commit writes the snake_case from_osm flag the payload reads', async () => {
        // building-select.js must set the SNAKE_CASE field (not only the legacy camelCase
        // one) on an OSM footprint pick, so the two can never disagree again.
        expect(buildingSelectJs).toContain('window.state.infrastructure_name_from_osm = true');
        // …and clear it when the footprint is deselected.
        expect(buildingSelectJs).toContain('window.state.infrastructure_name_from_osm = false');
    });

    test('editing the name does not demote an osm: footprint pick to free-text', async () => {
        // The free-text input handler keeps from_osm=true while an osm: footprint is
        // selected (only genuine free-text — no footprint — is flagged needs-mapping).
        expect(appJs).toContain("state.buildingId.indexOf('osm:') === 0");
    });
});
