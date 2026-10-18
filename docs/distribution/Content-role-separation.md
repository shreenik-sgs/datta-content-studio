# Content roles and independent review

Content generation uses the current `CONTENT_COORDINATOR` role. `TECH_SUPER_ADMIN`
and `SUPER_ADMIN` review and publish. These three content capabilities are automatic
role bundles; old per-person `content.*` grant rows cannot add authority. The Hub
still revalidates the core session on each request and preserves stage, world,
rights, native-language, feature and destination checks.

Existing campaign authoring, channel administration, analytics and operations remain
explicit Admin grants. They do not grant any Datta Circle membership or management.
An Admin without `CONTENT_COORDINATOR` cannot generate media. A person assigned both
roles may create and review different people's work, but cannot approve their own.

The persistence boundary compares immutable authors with the reviewer under the
existing source/revision locks. Source upload, metadata and rights contributors;
transcript, quote and native-analysis creators; render requesters; and inherited
campaign, CTA and activation-package authors must be independent of the reviewer.
Destination testing is not authoring. Export and worker dependency checks reject
historical self-approvals. An Admin author may export only after another eligible
Admin approved the current package. Editing invalidates the existing approval.

Native review additionally requires the explicit language qualification and current
Admin authority. The worker rechecks the current active creator role at claim and
completion. This uses `POST /api/v1/distribution-worker-authority`, a read-only,
versioned HMAC-authenticated core contract; the Hub never reads core tables.

The service is **OFF by default** and supports only localhost TEST rehearsal. To
adopt it locally, independently configure the same dedicated 32-byte hex secret as
`DISTRIBUTION_WORKER_AUTHORIZATION_KEY` in core, Hub and worker, set
`DISTRIBUTION_WORKER_AUTHORIZATION_ENABLED=true`, keep
`DISTRIBUTION_HUB_STAGE=TEST`, and point `DISTRIBUTION_CORE_ORIGIN` to the trusted
loopback core origin. The core database must remain local on port 5442. No secret
value is checked in. Requests bind the exact user, world, duty, nonce and timestamp;
responses echo that identity and are bounded and fresh. The client verifies a
domain-separated HMAC over the exact response bytes before parsing the assertion,
so reflecting a request signature or substituting a local responder cannot grant
authority. Missing configuration or an
outage rolls back worker claims without consuming an attempt. A confirmed role
revocation marks the job stale. Non-TEST adoption is not implemented by this service.

Validation includes role/escalation unit tests, immutable-author tests, signed
contract/tamper/outage tests, a real ephemeral-loopback client-to-core exchange, and
disposable PostgreSQL channel tests with separate synthetic creator/reviewer
accounts. No social provider sends, production profile changes, remote databases,
or live service flags are used by these tests.
