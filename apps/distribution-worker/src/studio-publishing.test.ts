import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStudioMediaToken } from "@satsang/distribution-assets";
import type { StudioPublicationClaim } from "@satsang/distribution-db";
import type { StudioOutput, StudioPackage, StudioPublication } from "@satsang/distribution-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StudioPublishingPorts, runStudioPublicationOnce } from "./studio-publishing";
const publicationId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const packageId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const outputId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const reviewerId = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const bytes = Buffer.from("verified synthetic output");
const checksum = createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function fixture(isTest = false) {
  const now = new Date().toISOString();
  const asset = {
    storageKey: "synthetic-asset",
    sha256: checksum,
    byteSize: bytes.length,
    mimeType: "image/png",
    filename: "synthetic.png",
  };
  const output: StudioOutput = {
    id: outputId,
    channel: "threads",
    format: "post",
    language: "en",
    title: "Ashrama reflection",
    body: "Avadhoota Datta Peetham: reflect with care.",
    rationale: "A source-grounded reflection",
    included: true,
    sourceSegmentIds: ["segment-1"],
    startMs: null,
    endMs: null,
    aspect: "1:1",
    asset,
    captions: [
      {
        language: "en",
        asset: { ...asset, mimeType: "text/vtt", filename: "captions.vtt" },
        translated: false,
      },
    ],
    warnings: [],
  };
  const pkg: StudioPackage = {
    id: packageId,
    isTest,
    revision: 3,
    status: "APPROVED",
    source: {
      masterId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      versionId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      sha256: "1".repeat(64),
      revision: 2,
      title: "Teaching",
      language: "en",
      category: "pravachanams",
      mimeType: "video/mp4",
    },
    createdBy: "coordinator",
    contributorIds: ["coordinator"],
    request: { channels: ["threads"], languages: ["en"], instructions: "", captions: true },
    outputs: [output],
    provenance: null,
    approval: { reviewerId, revision: 3, sourceRevision: 2, approvedAt: now },
    feedback: [],
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
  const publication: StudioPublication = {
    id: publicationId,
    packageId,
    packageRevision: 3,
    outputId,
    channel: "threads",
    isTest,
    status: "RUNNING",
    accountId: null,
    attempt: 1,
    error: null,
    errorDetail: null,
    remoteId: null,
    remoteUrl: null,
    createdAt: now,
    updatedAt: now,
  };
  const claim: StudioPublicationClaim = {
    publication,
    package: pkg,
    output,
    checkpoint: null,
    leaseToken: "lease",
    leaseOwner: "worker",
  };
  const repository = {
    reservePublicationDestination: vi.fn(async (_claim, _account, check) => ({
      allowed: true,
      check,
    })),
    claimPublication: vi.fn(async () => claim as StudioPublicationClaim | null),
    revalidatePublication: vi.fn<StudioPublishingPorts["repository"]["revalidatePublication"]>(
      async () => ({ accepted: true, package: pkg }),
    ),
    completePublication: vi.fn<StudioPublishingPorts["repository"]["completePublication"]>(
      async (_claim, result) => ({ ...publication, status: result.status }),
    ),
    pausePublicationsAfterRejections: vi.fn(async () => 0),
  };
  const fetcher = vi.fn<typeof fetch>();
  const store = { readDerivedDescriptor: vi.fn(async () => bytes) };
  const env = {
    STUDIO_PUBLISHING_ENABLED: "true",
    STUDIO_PUBLIC_ORIGIN: "https://ashrama.test",
    STUDIO_MEDIA_SIGNING_SECRET: "test-only-secret-that-is-over-thirty-two-characters",
    STUDIO_CHANNEL_CONFIG_FILE: "",
  };
  const ports: StudioPublishingPorts = {
    repository,
    store,
    isTest,
    workerId: "studio-worker",
    env,
    fetcher,
  };
  return { ports, repository, fetcher, store, env, claim, output, pkg };
}
async function configure(ports: StudioPublishingPorts, change: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "studio-publisher-"));
  roots.push(root);
  const path = join(root, "config.json");
  const config = {
    version: 1,
    trustedMediaOrigins: ["https://ashrama.test"],
    accounts: [
      {
        id: "account-1",
        platform: "threads",
        transport: "buffer",
        providerAccountId: "channel-1",
        world: "PRODUCTION",
        enabled: true,
        eligibilityVerified: true,
        accessToken: "synthetic-only",
        ...change,
      },
    ],
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  ports.env.STUDIO_CHANNEL_CONFIG_FILE = path;
  return { path, config };
}
const channel = () =>
  Response.json({
    data: {
      channel: {
        id: "channel-1",
        service: "threads",
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
      },
    },
  });
function providerPost(text: string, status = "sending") {
  return {
    id: "provider-post-1",
    channelId: "channel-1",
    channelService: "threads",
    text,
    status,
    schedulingType: "automatic",
    sentAt: status === "sent" ? new Date().toISOString() : null,
    externalLink: status === "sent" ? "https://www.threads.com/@ashrama/post/actual-id" : null,
  };
}

describe("durable Studio publication worker", () => {
  it("returns idle when no durable publication was claimed", async () => {
    const { ports, repository, store, fetcher } = fixture();
    repository.claimPublication.mockResolvedValue(null);
    expect(await runStudioPublicationOnce(ports)).toBe(false);
    expect(store.readDerivedDescriptor).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies TEST output and caption bytes then simulates without reading credentials or sending", async () => {
    const { ports, repository, store, fetcher, env } = fixture(true);
    env.STUDIO_CHANNEL_CONFIG_FILE = "/does/not/exist";
    expect(await runStudioPublicationOnce(ports)).toBe(true);
    expect(store.readDerivedDescriptor).toHaveBeenCalledTimes(2);
    expect(repository.revalidatePublication).toHaveBeenCalledTimes(2);
    expect(repository.completePublication).toHaveBeenCalledWith(expect.anything(), {
      status: "SIMULATED",
      error: "TEST_PUBLICATION_NO_EXTERNAL_SEND",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends an approved file from a mixed package after sibling revisions without sending its draft sibling", async () => {
    const { ports, repository, fetcher } = fixture(true);
    const claim = await repository.claimPublication();
    if (!claim || !claim.package.approval) throw Error("MISSING_FIXTURE");
    claim.output.workflow = {
      status: "APPROVED",
      actorId: claim.package.approval.reviewerId,
      updatedAt: claim.package.updatedAt,
      approval: { ...claim.package.approval, fingerprint: "test-only" },
    };
    claim.package = {
      ...claim.package,
      status: "DRAFT",
      approval: null,
      revision: claim.package.revision + 2,
      outputs: [
        claim.output,
        {
          ...claim.output,
          id: "draft-sibling",
          workflow: { status: "DRAFT", actorId: "curator", updatedAt: claim.package.updatedAt },
        },
      ],
    };
    repository.revalidatePublication.mockResolvedValue({
      accepted: true,
      package: { ...claim.package, revision: claim.package.revision + 1 },
    });
    expect(await runStudioPublicationOnce(ports)).toBe(true);
    expect(repository.completePublication).toHaveBeenCalledWith(claim, {
      status: "SIMULATED",
      error: "TEST_PUBLICATION_NO_EXTERNAL_SEND",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "blocks altered asset bytes before publishing or simulating (TEST %s)",
    async (isTest) => {
      const { ports, repository, store, fetcher } = fixture(isTest);
      store.readDerivedDescriptor.mockResolvedValue(Buffer.from("changed"));
      await runStudioPublicationOnce(ports);
      expect(repository.completePublication).toHaveBeenCalledWith(expect.anything(), {
        status: "BLOCKED",
        error: "ASSET_INTEGRITY_FAILED",
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("does not send when the Admin switch removes authority after claim and asset checks", async () => {
    const { ports, repository, store, fetcher, pkg } = fixture();
    await configure(ports);
    repository.revalidatePublication
      .mockResolvedValueOnce({ accepted: true, package: pkg })
      .mockRejectedValueOnce(new Error("OPERATOR_AUTHORITY_UNAVAILABLE"));
    await runStudioPublicationOnce(ports);
    expect(store.readDerivedDescriptor).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
    expect(repository.completePublication).toHaveBeenCalledWith(expect.anything(), {
      status: "BLOCKED",
      error: "PUBLICATION_VALIDATION_FAILED",
    });
  });
  it("leaves an unavailable queued authority unclaimed and never attempts external dispatch", async () => {
    const { ports, repository, store, fetcher } = fixture();
    repository.claimPublication.mockRejectedValueOnce(new Error("OPERATOR_AUTHORITY_UNAVAILABLE"));
    await expect(runStudioPublicationOnce(ports)).rejects.toThrow("OPERATOR_AUTHORITY_UNAVAILABLE");
    expect(store.readDerivedDescriptor).not.toHaveBeenCalled();
    expect(repository.completePublication).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks production publication until explicitly enabled", async () => {
    const { ports, repository, env, fetcher } = fixture();
    env.STUDIO_PUBLISHING_ENABLED = "false";
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication).toHaveBeenCalledWith(expect.anything(), {
      status: "BLOCKED",
      error: "PUBLISHING_DISABLED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks current source/approval after asset IO and respects repository revocation", async () => {
    const { ports, repository, store, fetcher } = fixture();
    store.readDerivedDescriptor.mockImplementation(async () => {
      repository.revalidatePublication.mockResolvedValue({
        accepted: false,
        reason: "PUBLISHER_ROLE_REVOKED",
      });
      return bytes;
    });
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("persists Buffer processing checkpoint and reconciles it without reposting", async () => {
    const { ports, repository, fetcher, claim, output, env } = fixture();
    await configure(ports);
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(
        Response.json({ data: { createPost: { post: providerPost(output.body) } } }),
      );
    await runStudioPublicationOnce(ports);
    const result = repository.completePublication.mock.calls[0]?.[1];
    expect(result).toMatchObject({
      status: "PROCESSING",
      accountId: "account-1",
      remoteId: "provider-post-1",
      retryAfterSeconds: 30,
    });
    const payload = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).variables.input;
    const url = new URL(payload.assets[0].image.url);
    expect(
      verifyStudioMediaToken(url.searchParams.get("token") ?? "", env.STUDIO_MEDIA_SIGNING_SECRET),
    ).toMatchObject({ publicationId, packageId, outputId, revision: 3, sha256: checksum });
    expect(url.origin).toBe("https://ashrama.test");
    claim.checkpoint = result?.checkpoint ?? null;
    claim.publication.accountId = "account-1";
    claim.publication.remoteId = "provider-post-1";
    fetcher.mockResolvedValueOnce(
      Response.json({ data: { post: providerPost(output.body, "sent") } }),
    );
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[1]?.[1]).toMatchObject({
      status: "PUBLISHED",
      remoteId: "provider-post-1",
      remoteUrl: "https://www.threads.com/@ashrama/post/actual-id",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).query).toContain(
      "query HubReceipt",
    );
  });
  it("records a channel rejection as failed and asks for the account's queue to be paused", async () => {
    const { ports, repository, fetcher, claim, output } = fixture();
    await configure(ports);
    fetcher.mockResolvedValueOnce(channel()).mockResolvedValueOnce(
      Response.json({
        data: {
          createPost: {
            post: {
              ...providerPost(output.body, "error"),
              error: { message: "The user has exceeded the number of videos they may upload." },
            },
          },
        },
      }),
    );
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "FAILED",
      error: "BUFFER_PUBLISH_FAILED",
      errorDetail: "The user has exceeded the number of videos they may upload.",
      remoteId: "provider-post-1",
    });
    expect(repository.pausePublicationsAfterRejections).toHaveBeenCalledWith(claim, "account-1");
  });
  it("uses the pinned second account even if the first remains default", async () => {
    const { ports, repository, fetcher, claim, output } = fixture();
    const { path, config } = await configure(ports);
    const original = config.accounts[0];
    if (!original) throw Error("MISSING_ACCOUNT");
    await writeFile(
      path,
      JSON.stringify({
        ...config,
        accounts: [
          { ...original, providerAccountId: "other-channel", isDefault: true },
          { ...original, id: "selected-second", isDefault: false },
        ],
      }),
      { mode: 0o600 },
    );
    claim.publication.accountId = "selected-second";
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(
        Response.json({ data: { createPost: { post: providerPost(output.body) } } }),
      );
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "PROCESSING",
      accountId: "selected-second",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).variables.input.channelId).toBe(
      "channel-1",
    );
    repository.completePublication.mockClear();
    fetcher.mockClear();
    claim.publication.accountId = null;
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "BLOCKED",
      error: "STUDIO_PUBLISH_ACCOUNT_REQUIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses a changed configured account before following an existing checkpoint", async () => {
    const { ports, repository, fetcher, claim } = fixture();
    await configure(ports);
    claim.publication.accountId = "different-account";
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication).toHaveBeenCalledWith(expect.anything(), {
      status: "BLOCKED",
      error: "PUBLISHING_ACCOUNT_CHANGED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("retries only transient receipt reads with the saved checkpoint and stops after twenty polls", async () => {
    const { ports, repository, fetcher, claim, output } = fixture();
    await configure(ports);
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(
        Response.json({ data: { createPost: { post: providerPost(output.body) } } }),
      );
    await runStudioPublicationOnce(ports);
    claim.checkpoint = repository.completePublication.mock.calls[0]?.[1].checkpoint ?? null;
    claim.publication.accountId = "account-1";
    claim.publication.remoteId = "provider-post-1";
    claim.publication.attempt = 2;
    fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[1]?.[1]).toMatchObject({
      status: "PROCESSING",
      error: "BUFFER_RECEIPT_UNAVAILABLE",
      checkpoint: claim.checkpoint,
      remoteId: "provider-post-1",
    });
    claim.publication.attempt = 21;
    fetcher.mockRejectedValueOnce(new Error("temporary transport failure"));
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[2]?.[1]).toMatchObject({
      status: "UNCERTAIN",
      error: "RECEIPT_RETRY_EXHAUSTED",
      checkpoint: claim.checkpoint,
    });
    for (const call of fetcher.mock.calls.slice(2))
      expect(JSON.parse(String(call[1]?.body)).query).toContain("query HubReceipt");
  });
  it.each([
    new Response("malformed", { status: 200 }),
    Response.json({ errors: [{ message: "invalid token" }] }, { status: 401 }),
  ])("does not retry malformed or rejected receipt queries", async (response) => {
    const { ports, repository, fetcher, claim, output } = fixture();
    await configure(ports);
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(
        Response.json({ data: { createPost: { post: providerPost(output.body) } } }),
      );
    await runStudioPublicationOnce(ports);
    claim.checkpoint = repository.completePublication.mock.calls[0]?.[1].checkpoint ?? null;
    claim.publication.accountId = "account-1";
    claim.publication.remoteId = "provider-post-1";
    claim.publication.attempt = 2;
    fetcher.mockResolvedValueOnce(response);
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[1]?.[1]).toMatchObject({
      status: "UNCERTAIN",
    });
  });
  it("rechecks configured credentials and Admin eligibility after Buffer preflight", async () => {
    const { ports, repository, fetcher } = fixture();
    const { path, config } = await configure(ports);
    fetcher.mockImplementationOnce(async () => {
      await writeFile(
        path,
        JSON.stringify({
          ...config,
          accounts: config.accounts.map((account) => ({ ...account, enabled: false })),
        }),
      );
      return channel();
    });
    await runStudioPublicationOnce(ports);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "BLOCKED",
      error: "APPROVAL_OR_ACCOUNT_CHANGED",
    });
  });
  it("marks lost mutation responses uncertain without automatic retry", async () => {
    const { ports, repository, fetcher } = fixture();
    await configure(ports);
    fetcher.mockResolvedValueOnce(channel()).mockRejectedValueOnce(new Error("lost response"));
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "UNCERTAIN",
      error: "PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("never writes a second completion or resends after an unknown DB commit", async () => {
    const { ports, repository, fetcher, output } = fixture();
    await configure(ports);
    fetcher
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(
        Response.json({ data: { createPost: { post: providerPost(output.body) } } }),
      );
    repository.completePublication.mockRejectedValue(new Error("lost COMMIT acknowledgement"));
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("publishes an approved website blog by metadata only after actual asset checks", async () => {
    const { ports, repository, fetcher, output, claim } = fixture();
    output.channel = "website";
    output.format = "blog";
    output.aspect = "prose";
    if (!output.asset) throw new Error();
    output.asset.mimeType = "text/markdown";
    claim.publication.channel = "website";
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toEqual({
      status: "PUBLISHED",
      accountId: "ashrama-website",
      remoteId: publicationId,
      remoteUrl: `https://ashrama.test/distribution/blog/${publicationId}`,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks expired media delivery links before any external call", async () => {
    const { ports, repository, fetcher, claim } = fixture();
    await configure(ports);
    claim.publication.createdAt = "2020-01-01T00:00:00Z";
    await runStudioPublicationOnce(ports);
    expect(repository.completePublication.mock.calls[0]?.[1]).toMatchObject({
      status: "BLOCKED",
      error: "STUDIO_MEDIA_ACCESS_EXPIRED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("never enters a provider when the durable duplicate reservation refuses", async () => {
  const f = fixture();
  await configure(f.ports);
  f.repository.reservePublicationDestination.mockImplementationOnce(
    async (_claim, _account, check) => ({ allowed: false, check }),
  );
  await runStudioPublicationOnce(f.ports);
  expect(f.repository.reservePublicationDestination).toHaveBeenCalledOnce();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.repository.completePublication).not.toHaveBeenCalled();
});
it("checks YouTube uploads outside Studio and blocks a metadata match before createPost", async () => {
  const f = fixture();
  f.output.channel = "youtube";
  f.output.format = "short";
  if (!f.output.asset) throw Error("MISSING_ASSET");
  f.output.asset = { ...f.output.asset, mimeType: "video/mp4" };
  f.claim.publication.channel = "youtube";
  await configure(f.ports, {
    platform: "youtube",
    defaults: {
      youtube: { privacy: "private", madeForKids: false, isAiGenerated: false, categoryId: "27" },
    },
  });
  f.fetcher.mockResolvedValueOnce(
    Response.json({
      data: {
        channel: {
          id: "channel-1",
          service: "youtube",
          serviceId: `UC${"x".repeat(22)}`,
          organizationId: "org",
          isDisconnected: false,
          isLocked: false,
        },
      },
    }),
  );
  f.fetcher.mockResolvedValueOnce(
    Response.json({
      data: {
        posts: {
          edges: [
            {
              node: {
                id: "external",
                channelId: "channel-1",
                channelService: "youtube",
                status: "sent",
                text: f.output.body,
                metadata: { title: f.output.title },
                sentAt: "2026-10-22T00:00:00Z",
                externalLink: "https://www.youtube.com/watch?v=abcdefghijk",
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }),
  );
  f.repository.reservePublicationDestination.mockImplementationOnce(
    async (_claim, _account, check) => ({ allowed: check.matches.length === 0, check }),
  );
  await runStudioPublicationOnce(f.ports);
  expect(f.repository.reservePublicationDestination.mock.calls[0]?.[2].matches[0]).toMatchObject({
    state: "NEEDS_REVIEW",
    origin: "channel",
  });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(
    f.fetcher.mock.calls.every(([, i]) => JSON.parse(String(i?.body)).query.startsWith("query")),
  ).toBe(true);
});
it("fails closed on a broken channel-history query without attempting a send", async () => {
  const f = fixture();
  f.output.channel = "youtube";
  f.output.format = "short";
  if (!f.output.asset) throw Error("MISSING_ASSET");
  f.output.asset = { ...f.output.asset, mimeType: "video/mp4" };
  f.claim.publication.channel = "youtube";
  await configure(f.ports, {
    platform: "youtube",
    defaults: {
      youtube: { privacy: "private", madeForKids: false, isAiGenerated: false, categoryId: "27" },
    },
  });
  f.fetcher.mockRejectedValue(Error("secret provider diagnostics"));
  f.repository.reservePublicationDestination.mockImplementationOnce(
    async (_claim, _account, check) => ({ allowed: !check.error, check }),
  );
  await runStudioPublicationOnce(f.ports);
  expect(f.repository.reservePublicationDestination.mock.calls[0]?.[2].error).toBe(
    "STUDIO_POSTING_CHECK_UNAVAILABLE",
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
