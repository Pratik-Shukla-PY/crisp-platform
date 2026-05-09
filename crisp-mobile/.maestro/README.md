# Maestro flow scaffolding (Phase 4 — RN parity)

Maestro is a UI-test framework for native mobile that doesn't need
Detox's heavy native build setup — it works against an installed Expo
Go app or a built APK. Phase 4 of the Lighthouse QA pipeline scaffolds
Maestro YAMLs here so a follow-up commit can wire them into CI when
the native build infrastructure is ready.

## What's here

| File | Covers |
|---|---|
| `v4-capture-flow.yaml` | Walk the v4 capture → classify → review flow |
| `consent-and-channels.yaml` | Verify the merged home page renders all channels |
| `offline-queue.yaml` | Toggle airplane mode, submit, verify queue persists |

## Running locally (manual, today)

1. Install Maestro: `curl -Ls https://get.maestro.mobile.dev | bash`
2. Install Expo Go on an Android emulator or physical device.
3. Boot the Expo dev server: `cd crisp-mobile && npm start`
4. Open the app in Expo Go (scan QR or pick from menu).
5. Run a flow: `maestro test crisp-mobile/.maestro/v4-capture-flow.yaml`

## Wiring into CI (not done yet)

GitHub Actions has a Maestro Cloud action that can run flows on
real Android devices. Sample workflow stub:

```yaml
- uses: mobile-dev-inc/action-maestro-cloud@v1
  with:
    api-key: ${{ secrets.MAESTRO_CLOUD_API_KEY }}
    app-file: ./crisp-mobile/build/app-release.apk
```

Prerequisites:
- An EAS build pipeline that produces an APK on every push to main.
- A Maestro Cloud account (~$30/month for the smallest tier; free for
  open-source projects via their OSS program).

Until those are in place, run flows manually.

## PWA-vs-RN parity

The PWA Playwright suite captures full-page screenshots at every v4
stage (see `e2e/tests/pwa/42-visual-regression.spec.ts`). The Maestro
flows above capture matching screenshots on RN. To do a parity check:

1. Run both suites with the same baseline locale (`en`).
2. Compare PWA `stage-v4-capture.png` against RN equivalent visually.
3. Or open Claude Code and ask: *"compare the PWA stage-v4-capture
   screenshot against the RN one — what's different?"*

The acceptable variance:
- Native chrome (status bar, nav bar) differs by design.
- Font rendering differs (system font vs FontAwesome web font).
- Channel buttons + section labels + impact metrics + primary CTA
  must match in label + position + relative size.

Inconsistencies become bug reports — file under "PWA-RN parity" label.
