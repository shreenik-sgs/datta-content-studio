# Circle role UI: local acceptance

Verified 5 October 2026 on the isolated localhost TEST preview. This receipt covers the web and native Circle interfaces and the responsive guidance author/reviewer screens. It authorizes no deployment, provider publication or remote database changes.

## Implemented paths and permissions

- `/admin/circles`: Admin creates circles and assigns or revokes their coordinators. The server checks the exact Admin permission; controls also follow current server-returned capabilities.
- `/circles` and `/circles/{id}`: coordinators see forms only for their assigned circles; ordinary members see updates and room entry. Invitation acceptance is explicit. Coordinators publish circle announcements, withdraw updates, invite/remove members, and create/edit/close/reopen their circle rooms. Closing the circle itself requires an Admin to reopen it.
- Expo `/circles` and `/circles/[id]`: equivalent capability-driven forms and real API commands, accessible input labels and buttons, keyboard avoidance, error/retry/empty states, canonical room navigation, and Community/coordinator navigation entries. The Sri Swamiji Community exception is preserved.
- Room choices reuse approved canonical sources or a community room without media. The UI accepts no arbitrary external room destination. These forms do not send email, social messages or notifications.
- The guidance author can edit and submit a draft; the independent Admin reviews read-only content and approves the exact version. The author has no approval/publication button. The narrow layout now constrains intrinsic fieldset/input widths and wraps item action buttons.

Uncertain saves retain their input and request ID for a safe retry. Refusal clears private detail. A stale or revoked relationship does not imply management permission; the backend remains authoritative on every request. A revoked-only assignment to a manual circle is absent from the list and returns 404 on a fresh detail request.

## Executed checks

- 29 focused tests pass: nine web Circle component tests, six native Circle component tests and fourteen mobile navigation tests. Coverage includes visible capability boundaries, affirmative invitation consent, stable retry IDs, denied private detail, unsafe room destinations, empty state, and real native routes.
- Web and mobile TypeScript pass; the eighteen changed UI/test files pass Biome.
- Chromium and WebKit execute Admin creation/appointment, coordinator announcement and room create/edit/close/reopen, invitation/member consent, member canonical room entry, second-coordinator cross-circle denial, frozen legacy centre scope, assignment revocation and guest sign-in/API refusal.
- Both browser engines check widths 320, 390 and 1440px without horizontal document overflow. Keyboard Enter submits creation, announcement and consent. Full-page screenshots were inspected for phone and desktop hierarchy, labels, wrapping and form readability.
- The synthetic guidance collection was independently approved through the Chromium UI; both engines verify author editability, Admin read-only fields and the subsequent publication control. It was not published. Final repeat runs observe the already-approved version.

The test runner uses only local synthetic identities, blocks browser requests to other origins, disables service workers, and writes no credential to committed evidence. A prior repeat recorded one transient WebKit fetch diagnostic for the existing incoming-call poll during navigation; its handler already catches read errors. The strict runtime-error assertion was retained for the final run.

## Evidence

The [machine-readable receipt](evidence/circles/circle-role-ui-acceptance.json) and selected original screenshots are in `evidence/circles/`. Final browser result: **4 passed, 0 skipped, 0 unexpected failures** in 89.2 seconds. Selected views: [Admin phone](evidence/circles/circles-admin-webkit-320.png), [coordinator desktop](evidence/circles/circles-coordinator-chromium-1440.png), [member phone](evidence/circles/circles-member-webkit-320.png), [legacy scope phone](evidence/circles/circles-legacy-webkit-320.png), [guidance author phone](evidence/circles/guidance-author-webkit-320.png), and [reviewer desktop](evidence/circles/guidance-reviewer-chromium-1440.png). The receipt records the final browser results, viewport matrix, source fingerprints and explicit acceptance limits. All original three-width screenshots remain in the ignored local `test-results/circles/` output. Authentication fixtures remain private under `/private/tmp`.

## Acceptance limits

The new native Circle screens have component and TypeScript coverage. They have not been rebuilt or exercised on an iOS Simulator, Android emulator or physical device in this delta. Earlier content/native receipts refer to their earlier build and are not evidence for these new Circle screens. Screen-reader speech, physical-device keyboard behavior and release builds remain unverified here. Browser viewport checks are not native-device certification.

The parent integration run owns full-repository gates and the local commit. The parent confirmed restoration of the temporary TEST `weekly_guidance_admin` stage to `OFF` after these checks.

## Reproduction

Run the UI tests with:

```sh
pnpm exec vitest run apps/web/src/components/circles-panel.test.tsx apps/mobile/src/circles-screen.test.tsx apps/mobile/src/tabs.test.ts
pnpm --filter @satsang/mobile typecheck
pnpm --filter @satsang/web exec tsc --noEmit
```

The dedicated browser config uses a pre-started localhost preview and has no default database setup or fixture sweep. Supply `CIRCLES_E2E_ENABLED=true`, `CIRCLES_E2E_ORIGIN`, the private `CIRCLES_E2E_FIXTURE_FILE`, and private `GUIDANCE_ROLE_FIXTURE_FILE`, then run `pnpm exec playwright test --config tests/circles.playwright.config.ts`. The Circle fixture uses a separate Admin, two scoped coordinators, an invited member and a frozen-scope legacy coordinator; the guidance fixture adds a separate Content Coordinator.
