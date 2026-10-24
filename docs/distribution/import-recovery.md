# Playlist import recovery

Implemented locally and provisioned on private AWS hosts. Cloud rollout evidence is tracked below; a human Google sign-in and a successful media download remain separate acceptance gates. Neither health checks nor loading a YouTube page prove download access.

## Curator experience

Continue Existing Curation → Open playlist. When YouTube blocks import, choose **Verify YouTube access**. The page shows an isolated browser running in the importer process. Complete any challenge YouTube offers, then choose **Check access and resume playlist**. A playlist listing alone cannot mark the session verified: the importer must save an actual pending video. Completed masters and existing packages remain unchanged.

Alternatively expand **Upload original recordings**, select the files together, check the suggested recording matches, and choose **Upload originals and continue**. The playlist must have loaded its recording list before original files can be assigned. Only unambiguous video IDs and exact titles are automatically matched. Duplicate/ambiguous assignments require a selection. The browser uploads sequentially; a failed file can be retried without re-uploading successes. Supported recordings are MP4, MP3, WAV and M4A, at most 2 GB each. Private storage checks the media signature and checksum. Requests stream to private temporary disk rather than buffering a whole playlist. Existing shared permissions/generation settings drive the existing generation queue after attachment. Human approvals are never bypassed.

The Approver has no import, upload or browser-control permission unless also a Curator. Every browser action and attachment rechecks Curator authority and environment. Sessions are bound to the initiating user and import. Google credentials are entered directly into the isolated browser, never into an app settings form. No provider account is automatically signed in or CAPTCHA solved by the app.

## Service configuration

### Standalone Studio repair — 24 October 2026

The independent GBADPT deployment drops all container capabilities. The upstream
Playwright profile made `chroot` conditional on `CAP_SYS_CHROOT`, so Chromium failed
while creating its own user-namespace sandbox even though the worker health endpoint
was healthy. The profile now permits that syscall without granting a host capability;
the kernel's namespace/capability checks, default-deny seccomp, non-root user,
`--cap-drop ALL`, `no-new-privileges` and Chromium sandbox all remain enabled.
Chromium's [sandbox implementation](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc)
uses this operation to enter an empty root inside its namespace.

`ops/staging/start-services.sh` now starts and checks an actual sandboxed browser in
a temporary container with no network, credentials or mounts before replacing the
running service. A passing database health check alone is insufficient.

The standalone local runtime must also supply the verification variables below to
both web and worker, with its own key and an unused loopback port. Configuration is
retained across code releases; do not copy another environment's verification key.
Missing configuration, connection failures and browser startup failures now have
distinct operator-facing errors. Worker logs contain only the safe failure code.

The importer already attempts downloads automatically before requesting human input.
After a user completes Google sign-in and returns to YouTube, the recovery panel now
requests one automatic media access check. Navigation alone never marks verification
successful: a recording must be saved. A challenge on YouTube itself still requires
the user to finish it and select **Check access and resume playlist**. No CAPTCHA is
automatically solved, dismissed or bypassed.

The implementation is opt-in. Set these server variables separately in each environment:

| Variable | Where | Value |
| --- | --- | --- |
| `STUDIO_IMPORT_VERIFICATION_ENABLED` | Studio worker | `true` |
| `STUDIO_IMPORT_VERIFICATION_PORT` | Studio worker | An unused internal port, e.g. `3073` |
| `STUDIO_IMPORT_VERIFICATION_HOST` | Studio worker | Default `127.0.0.1`; use `0.0.0.0` only behind the private service boundary |
| `STUDIO_IMPORT_VERIFICATION_ORIGIN` | Hub web | Worker control origin. HTTPS required except loopback HTTP |
| `STUDIO_IMPORT_VERIFICATION_KEY` | Both | Same random 32-byte hex secret within one environment; different secret in other environments |

Keep the key in the environment's existing SSM/Secrets Manager mechanism and task roles. It is never returned to the browser. The authenticated Hub signs commands with timestamp and nonce; the worker rejects invalid signatures, replay, browser Origin headers and wrong-world sessions. Do not expose the worker's control port, Chrome debugging port, VNC or browser profile publicly.

Build Docker target `distribution-studio-verification`, which includes the pinned Playwright browser, Xvfb and downloader. This target runs as the existing non-root user and launches Chromium with its sandbox enabled. The host must support that sandbox; verify Linux user namespaces/seccomp on the selected runtime. Do not silently add `--no-sandbox` to fix an incompatible host. See [Playwright's container guidance](https://playwright.dev/docs/docker). The checked-in `ops/import-verification-seccomp.json` is the Playwright v1.62.1 Docker profile (Apache-2.0; https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/seccomp_profile.json). It preserves the default-deny syscall policy while allowing the user-namespace operations required by Chromium. The local container browser opened YouTube successfully with `--init --shm-size=256m --security-opt seccomp=ops/import-verification-seccomp.json`, without privileged mode or additional capabilities. The same test failed under Docker’s default profile, so this runtime setting is required, not optional.

On an ECS runtime that cannot supply the required sandbox, use an isolated EC2-backed importer host or another sandbox-capable runtime before enabling the feature.

The verification browser and downloader deliberately run in the same importer process/network namespace. Use one importer endpoint per environment, with stable egress during each session (a fixed NAT/EIP where needed); do not place the browser on a different network path. A PostgreSQL advisory lease elects one active importer during replacements. For the first rollout, stop the prior importer before starting this version because older builds do not acquire this new leader lease. Keep generation/publication and core services otherwise unchanged.

Use a private TLS endpoint if Hub and worker are in different tasks; restrict inbound access to the Hub security group. Allow the worker's existing database, core authority, private S3 and provider connections. Allocate enough temporary disk for two copies of a 2 GB original plus renderer scratch space. Only the approved provider hosts can be reached through the browser/download proxy; each DNS response is checked and pinned to a public address. The browser process receives a minimal environment, excluding AWS, database and AI credentials.

Browser sessions expire after 15 minutes; a media check has a bounded timeout. Verified cookies are kept only in worker memory for at most two hours and scoped to that bundle. yt-dlp receives a mode-0600 temporary cookie file, removed when its command ends. Only YouTube-domain cookies are exported. Restarting the worker expires sessions. Staging and production do not share browser profiles, keys or cookies.

## Validation and rollout

The embedded view streams webpage pixels, not Chromium's native device/passkey dialogs. If Google
opens “Connecting to your device”, that prompt may wait outside the view. Cancel it and choose a
password or Google's “Try another way”; the user completes the chosen authentication and any
verification. The Hub explains this on Google's sign-in page and waits for the page to return to
YouTube before enabling the access check. This is only a navigation guard: access is still confirmed
by a successful authorized download, never by a cookie or a page change alone. Do not disable Google
security checks or introduce virtual credentials to work around a rejected sign-in.

Client verification requests have bounded deadlines and release their controls after a timeout.
Status polling shares the input queue so an old snapshot cannot overwrite a close action; leaving
the panel cancels outstanding client requests. Recovered progress/connection warnings clear after
a successful response. These UI changes do not restart the importer or discard an active sign-in.

1. Run the repository checks and the disposable database integration suite.
2. Check Curator and Approver visibility; verify the remote browser opens, accepts mouse/keyboard controls, and expires without losing the playlist.
3. Confirm an actual media download before reporting verified. A failed download must retain the blocked state and show the original-upload alternative.
4. Upload multiple originals into a paused fixture playlist, confirm their lineage and shared settings, verify each queues once, and confirm previous master/approval revisions do not change. Remove fixture data afterward.
5. On staging, verify a real AWS challenge with the user's interaction, then download the remaining playlist. Test interrupted sessions/restarts and original-file fallback there as well. Only promote after this passes.
6. Repeat the environment-specific acceptance in production during its authorized release. Existing YouTube publishing/GoLive OAuth settings are unrelated and must remain untouched.

YouTube can deny cloud downloads without offering a solvable challenge. The original-file path is the independent recovery route. Neither a local successful download nor a CAPTCHA completed on another computer establishes cloud access. See [yt-dlp's FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ) and [known issues](https://github.com/yt-dlp/yt-dlp/issues/3766).

## Local acceptance evidence — 13 October 2026

- Full repository checks: 4,261 tests passed, with 551 skipped by their existing environment gates.
- Separate disposable-database and upload-route suite: 27 tests passed.
- Signed-in Chromium Curator and mobile-sized WebKit combined Curator/Approver: verification opened, keyboard controls worked, two originals attached to their existing playlist members, and both queued under the saved English generation plan. Fixtures were removed afterward.
- The isolated browser session was accepted by the real downloader for a supplied public video (109,764,756 bytes); the temporary recording was removed. No CAPTCHA occurred locally, so this does not prove cloud challenge acceptance.
- The non-root container browser opened YouTube with the checked-in sandbox profile. AWS runtime provisioning and genuine staging challenge/download acceptance are still pending.

## AWS runtime separation

`ops/import-verification/template.py` renders a separate additive CloudFormation stack per environment. Input JSON contains `environment`, observed `vpcId`, private `subnetId`, existing `serviceSecurityGroup`, Hub `bucket`/`assetPrefix`, existing `databaseSecret`/`authoritySecret` ARNs, and a pinned official ARM64 Amazon Linux 2023 `amiId`. Resolve and inspect that AMI before rendering. The stack creates one private t4g.medium host by default (the current staging and production hosts use t4g.large after AWS capacity failures) with encrypted 30 GB gp3 disk, no public IP/SSH, an SSM role, restricted asset access, a retained configuration secret and 30-day logs. It does not own any core service or database. Bootstrap source and sandbox profile are compressed inside user data.

The instance's retained secret holds an immutable importer image digest, a minimal environment, and separate random control/TLS keys. The leaf certificate names the instance's private DNS name. The web task receives `STUDIO_IMPORT_VERIFICATION_ORIGIN`, the public certificate as base64 `STUDIO_IMPORT_VERIFICATION_CA`, and the control key from the same environment's secret. The server uses base64 `STUDIO_IMPORT_VERIFICATION_TLS_CERT`/`STUDIO_IMPORT_VERIFICATION_TLS_KEY`. Certificate and hostname validation stay enabled. Only the existing service security group reaches port 3073; HMAC authentication is additionally required.

The private host runs `STUDIO_WORKER_MODE=imports`; the Fargate Studio runs `STUDIO_WORKER_MODE=generation`. The default `all` remains backward compatible; localhost now explicitly separates these two modes as well, so rendering/provider restarts cannot interrupt downloads. The import host receives no AI provider credentials. Update the generation task first to stop the previous downloader, then activate the importer. Keep the current Hub settings, secrets, S3 paths, capacity and core images when updating its web/Studio task definitions. The independent import stack survives unrelated application releases; future infrastructure releases must preserve these task overrides.

The host's systemd service reads configuration afresh on restart; use SSM to restart it after updating the image digest or certificate. Secrets remain in private memory or mode-0600 files under `/run`, and are never included in logs. Deploy the same tested immutable images to production after staging acceptance.

For AWS changes, pass the application's existing CloudFormation execution role (`cdk-hnb659fds-cfn-exec-role-510724490093-ap-south-1`), review the change set, then execute it. If EC2 reports insufficient capacity, retain the new secret/log group, use an existing private subnet in another availability zone, or select `instanceType=t4g.large`; the renderer supports reusing `existingConfigSecret`/`existingLogGroup`. It rejects a retained secret from the other environment. Record the chosen instance size/cost in release evidence. No core service or user data needs replacement.

`configure.py <environment> <evidence-directory>` reads the completed stack and creates its TLS configuration without logging keys. It deliberately leaves the importer inactive. `release-template.py <deployed-template.json> <environment-release.json>` preserves the deployed stack and changes only the two Hub task definitions and the web execution role's read permission for the new secret. Use a CloudFormation change set with all existing parameter values preserved; confirm only Hub resources and their referencing services change. After the generation-only Studio is stable, set the importer secret's `ready` field to true and restart its systemd service through SSM. Verify TLS from the Hub network and a real browser/download before declaring acceptance.


## AWS recovery operations — 13 October 2026

The additive stacks are `SgsDattaSannidhiImportRecovery-staging` and `SgsDattaSannidhiImportRecovery-production` in ap-south-1. Current hosts are private t4g.large instances with encrypted 30 GB disks. Existing core application, account, GoLive/YouTube publishing and AI-provider secrets are preserved. No database migration is needed by this release.

Issues encountered and permanent corrections:

- CloudFormation using the MFA user's forwarded credentials failed resource operations. Supply the existing CDK CloudFormation execution role. Resolve the official ARM64 AMI and record its ID before provisioning.
- t4g.medium capacity was unavailable in the attempted availability zones. The renderer accepts the reviewed t4g.large fallback and reuses the same retained, environment-bound secret/log group.
- Amazon Linux bootstrap must install `awscli`, not `awscli2`. Both hosts were repaired and their CloudFormation user data corrected before activation.
- Direct SSM commands were asynchronously denied by the account's MFA enforcement. `remote.py` assumes a separate, environment-specific operator role that requires MFA and can send commands only to its importer. It does not weaken the account policy. Temporary role credentials remain in process memory.
- Large application templates exceed CloudFormation's inline limit. Upload the template to the private CDK assets bucket and use a short-lived presigned template URL, with request files mode 0600 and command output captured. Never log that URL or full AWS validation errors that may echo the template.
- `activate.py` checks that the generation-only Studio rollout is complete and older importer tasks have drained before activating the private importer. It refuses environment, image or host-identity mismatches.
- Export only the private origin and configuration-secret ARN. The infrastructure branch's `HubServices` consumes these with `-c importVerification=true`; the web task loads its key and public CA from Secrets Manager, while Studio retains generation-only mode. The application deployment workflow passes that context on subsequent releases. Initial provisioning can omit it until the importer stack exists. Four synthesis regression tests cover both environments and both provisioning phases.
- Recovery upload matches the Hub's own `youtube-<source-id>-master.mp4` filenames, including IDs containing hyphens/underscores. Uploaded originals preserve the playlist's source titles.

Verified before final promotion: 4,264 repository tests passed (551 environment-gated skips), 23 disposable-database tests passed, and four infrastructure synthesis tests passed. Staging's signed-in team Curator and Approver both load the Hub; the Curator opens the real private browser through pinned TLS and signed control requests, while the Approver is refused. Production's sandboxed browser also opens successfully. YouTube displays “Sign in to confirm you’re not a bot”; no automatic CAPTCHA or login was performed. A successful page load is not recorded as successful import.

Private release evidence is in `/private/tmp/hub-cloud-recovery-20261013` on the operator's Mac. It contains rollout manifests, change-set snapshots, screenshots and sanitized check results. Treat the directory as private operational evidence, not a source artifact. Google sign-in must be completed by the user inside their own environment's verification window. Existing authorized originals are the independent fallback; no test users, approval decisions or local TEST database records are copied into the cloud.


## Local service acceptance — 14 October 2026

Run `hub-preview-runtime/start-download-worker.mjs` for the independent TEST import worker and `start-generation-worker.mjs` for the generation-only supervisor. `start-preview.mjs` starts them separately. Keep their PID files/logs distinct. Never infer download health from the AI worker PID; the signed-in `/distribution/api/content/import` response must report `available: true` after changes, and an actual imported recording must become a playable master.

The Chaturthi archive `S8xhTbg2XFM` demonstrated two defects: the selector excluded native DASH fragments, and its complete manifest exceeded the eight-MB metadata bound. The importer now handles DASH via the existing constrained proxy and writes a compact after-download metadata projection instead of complete signed fragment manifests. Offline real-downloader regression checks cover DASH-only/mixed-format selection and bounded metadata.
