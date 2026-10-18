# Local curation correction verification — 11 October 2026

Scope: file-specific reviewer returns, AI/manual correction tools, immutable per-file versions, three curation tabs, desktop navigation and approved-file locking.

- `pnpm check`: guardrails, lint, type checks; 3964 tests passed, 508 skipped.
- Isolated local PostgreSQL Studio suite: 35 passed. Includes selected-file correction, rejection of unrelated output changes, independent approval and refusal of Curator edits/regeneration/discard after approval, with unchanged approved snapshot.
- Live TEST workflow used a synthetic two-file source. An Approver returned the blog, the Curator applied a real Gemini correction, and the video remained unchanged. A subsequent manual video passage/subtitle correction left the blog unchanged, required resubmission and received independent approval. No social publication occurred.
- Chromium and WebKit exercised both roles, keyboard navigation, preview playback and responsive layouts. The synthetic source was withdrawn after testing. Episode 249 and its 22 outputs were not modified.
- Verified synthetic fixtures were withdrawn using repository operations, not deleted from audit history. Active libraries retain the user's Episode 249 master.
- Generation was restored in the private local runtime using the existing configured Sarvam/Gemini providers. Credentials remain outside the committed code. Provider readiness was checked; this run did not perform a new live Sarvam transcription.

Runtime evidence is under `hub-preview-runtime/corrections-oct11` outside the repository. Local TEST publishing remains disabled. No GitHub push was performed.
