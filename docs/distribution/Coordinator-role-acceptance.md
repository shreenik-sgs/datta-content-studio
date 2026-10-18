# Coordinator roles: local acceptance

Verified locally on 5 October 2026. This change groups content duties into current application roles and scopes Datta Circle work to explicit assignments.

| Profile | Duties |
|---|---|
| Content Coordinator | Upload sources, record rights, prepare transcripts/quotes/native proposals, generate sharing variants, and draft/submit weekly guidance |
| Admin (Administrator or Super Admin) | Independently review and approve exact content versions; authorize exports/publication; create circles and appoint/revoke coordinators |
| Circle Coordinator | Update assigned circles, post to their members, invite/remove members, and create/edit/close/reopen their own circle rooms |
| Existing center coordinator | The same circle duties through a fixed assignment to that center's seeded circle |
| Member | Explicitly accept an invitation, read their circle's updates, enter its rooms, or leave |

Content creation and approval require different people, including when one account holds both roles. Replacing media cannot erase the author of retained metadata. Editing invalidates approval. Current account/role revocation is enforced again at the API and worker boundaries. Existing campaign/channel/analytics/operations administration retains its explicit Admin grants; an Admin who drafts a campaign or full package needs another Admin to approve it.

Native-language approval still needs the language qualification and teaching evidence. Ashrama templates, source provenance, rights and exact-artifact checks remain mandatory. No provider posting was performed during acceptance; public channel dispatch remains subject to the existing adoption gates.

## Circle isolation

Migrations `0111_circle_coordination.sql` and `0112_circle_legacy_scope.sql` add assignments, consented memberships, announcements and circle-owned rooms. Existing center assignments are frozen rather than inferred from a changeable profile center. Center/program/event seeds remain idempotent. No membership consent is invented by seeding or appointment.

Cross-circle access and revoked assignments are refused on room entry, chat, presence, playback embeds and practice beats. A room cannot silently change its circle or approved media source. Legacy translation, Blessings, live discovery and notification paths exclude private circle data; queued global notifications recheck this boundary. Local circle presence remains available. Practice ledger rows are unchanged by denied access, migration or membership changes.

## Executed validation

- Full repository gate: **402 test files / 3,289 tests passed**, with 42 files / 297 unrelated environment-gated tests skipped. Guardrails, formatting and core/mobile TypeScript passed. The run enabled the nurturing, distribution, guidance, content and Datta Circle disposable PostgreSQL suites.
- **20 browser cases passed** across Chromium and WebKit: circle/guidance roles (4), the new content role workflow (2), maintained source/version/authentication workflows (6), editorial/outreach workflows (4), native-language review (2), and actual queued video rendering/playback/export (2).
- The actual render worker used signed current-role assertions at claim and completion. Seven separate FFmpeg worker integration tests also passed. Source/version/review/export tests use distinct synthetic local identities.
- Core production web and Distribution Hub package builds passed locally. No deployment occurred.
- Browser checks cover narrow phone and desktop layouts, keyboard submission, immutable versions, independent review, cross-circle denial, membership consent, revocation and same-world access. Screenshots were inspected. The new native Circle screens have component and TypeScript coverage; fresh iOS/Android runtime verification of those screens is still outstanding.

The detailed [Circle UI receipt](Circle-role-ui-acceptance.md), [content authority contract](Content-role-separation.md), and screenshots under `evidence/circles/` and `evidence/roles/` preserve the scope and limits. Earlier failed development rehearsals identified narrow-screen overflow, an inherited metadata contributor omission, and an obsolete competing local worker; those were corrected before the final passing runs.

## Local preview and cleanup

Core remains at port 3020 and Hub at 3070. The older render worker was replaced with the current worker. Its dedicated HMAC authority is configured only in the private localhost TEST preview; repository defaults remain OFF and no key is committed. Temporary rehearsal servers on 3025/3075 were stopped. The temporary `weekly_guidance_admin` switch was restored to its recorded OFF state; other guidance switches remain OFF. No remote database, production profile, real invitation, social provider or GitHub repository was changed.

Local commit and fast-forward merge are performed only after the required pre-commit gate succeeds.
