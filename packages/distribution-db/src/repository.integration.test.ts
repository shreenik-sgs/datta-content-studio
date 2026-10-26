import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ContentRights, OnlineImport } from "@satsang/distribution-domain";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDistributionEditorialRepository } from "./editorial-repository.js";
import { createOnlineImportRepository } from "./online-import-repository.js";
import { createDistributionRepository, provisionDistributionCapabilities } from "./repository.js";
import { createIntelligentContentRepository } from "./studio-repository.js";

const run = process.env.DISTRIBUTION_RUN_DB_TESTS === "1";
const suite = run ? describe : describe.skip;
suite("DS-DIST-R1-CONTENT disposable local PostgreSQL boundary", () => {
  let admin: Pool;
  let migration: Pool;
  let runtime: Pool;
  let repository: ReturnType<typeof createDistributionRepository>;
  let editorial: ReturnType<typeof createDistributionEditorialRepository>;
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `distribution_r1_${suffix}`;
  const migrateRole = `distribution_migrate_${suffix}`;
  const runtimeRole = `distribution_runtime_${suffix}`;
  const ctx = { userId: "r1-operator@example.test", isTest: true, roles: ["CONTENT_COORDINATOR"] };
  const reviewer = {
    userId: "r1-reviewer@example.test",
    isTest: true,
    roles: ["CONTENT_APPROVER"],
  };
  const other = { ...ctx, isTest: false };
  const asset = () => ({
    storageKey: `distribution/masters/${randomUUID()}`,
    sha256: randomUUID().replaceAll("-", "").repeat(2),
    byteSize: 123,
    mimeType: "audio/mpeg",
    originalName: "chant.mp3",
  });
  const rights: ContentRights = {
    owner: "SGS",
    territories: ["WORLDWIDE"],
    channels: ["manual_export"],
    authorizationBasis: "Owner permission",
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  };
  const create = () =>
    repository.create(ctx, {
      title: "Sacred music",
      language: "en",
      category: "bhajans",
      asset: asset(),
    });
  it("renames organizing labels without changing source versions, rights or approval", async () => {
    const original = await create();
    const cleared = await repository.attestRights(ctx, original.id, {
      expectedRevision: original.revision,
      rights,
    });
    const approved = await repository.approve(reviewer, original.id, {
      expectedRevision: cleared.revision,
    });
    const renamed = await repository.rename(ctx, original.id, {
      name: "  My special teaching  ",
      expectedName: null,
    });
    expect(renamed.workspaceName).toBe("My special teaching");
    expect(renamed.title).toBe(original.title);
    expect(renamed.currentVersion).toEqual(approved.currentVersion);
    expect(renamed.approval).toEqual(approved.approval);
    expect(renamed.revision).toBe(approved.revision);
    expect(renamed.state).toBe(approved.state);
    expect(
      (await repository.list(ctx, { query: "special teaching" })).some((m) => m.id === original.id),
    ).toBe(true);
    await expect(
      repository.rename(ctx, original.id, { name: "Stale name", expectedName: null }),
    ).rejects.toThrow("WORKSPACE_NAME_CONFLICT");
    await expect(
      repository.rename(reviewer, original.id, {
        name: "Not allowed",
        expectedName: renamed.workspaceName ?? null,
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      repository.rename(other, original.id, { name: "Other world", expectedName: null }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("keeps a playlist's chosen name through discovery and a video's chosen name through download", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const playlist = await imports.enqueue(ctx, {
      url: "https://www.youtube.com/playlist?list=PLNamedCollectionTest",
      includePlaylist: true,
      title: "My named playlist",
      language: "te",
      category: "pravachanams",
    });
    const claim = await imports.claim(true);
    expect(claim?.id).toBe(playlist.id);
    if (!claim) throw Error("claim");
    await imports.expand(
      claim,
      [
        {
          provider: "youtube",
          kind: "video",
          id: "NamedVid001",
          url: "https://www.youtube.com/watch?v=NamedVid001",
        },
      ],
      "Provider playlist title",
    );
    let items = await imports.list(ctx, { rootId: playlist.id });
    expect(items.find((i) => i.id === playlist.id)?.title).toBe("My named playlist");
    const child = items.find((i) => i.parentId === playlist.id);
    if (!child) throw Error("child");
    await imports.rename(ctx, child.id, { name: "My lesson", expectedName: null });
    const download = await imports.claim(true);
    expect(download?.id).toBe(child.id);
    if (!download) throw Error("download");
    const result = await imports.complete(download, {
      title: "Original video title",
      asset: asset(),
    });
    const master = await repository.get(ctx, result.masterId);
    expect(master.workspaceName).toBe("My lesson");
    expect(master.title).toBe("Original video title");
    await repository.rename(ctx, master.id, { name: "Renamed lesson", expectedName: "My lesson" });
    items = await imports.list(ctx, { rootId: playlist.id });
    expect(items.find((i) => i.id === child.id)?.title).toBe("Renamed lesson");
    await imports.rename(ctx, playlist.id, {
      name: "My series",
      expectedName: "My named playlist",
    });
    expect(
      (await imports.list(ctx, { summaries: true, query: "My series" })).map((i) => i.id),
    ).toContain(playlist.id);
    expect((await imports.bundlesForMaster(ctx, master.id))[0]?.title).toBe("My series");
  });
  it("persists a complete online master larger than 2 GB after the capacity migration", async () => {
    const byteSize = 3 * 1024 ** 3;
    const item = await repository.create(ctx, {
      title: "Long online discourse",
      language: "en",
      category: "pravachanams",
      asset: { ...asset(), byteSize, mimeType: "video/mp4", originalName: "full-discourse.mp4" },
    });
    expect(item.currentVersion.byteSize).toBe(byteSize);
    expect((await repository.get(ctx, item.id)).currentVersion.byteSize).toBe(byteSize);
  });
  it("rejects renamed duplicates and simultaneous identical uploads without crossing worlds", async () => {
    const bytes = asset();
    const input = { title: "Duplicate guard", language: "en", category: "bhajans", asset: bytes };
    const first = await repository.create(ctx, input);
    await expect(
      repository.create(ctx, {
        ...input,
        title: "Renamed",
        asset: {
          ...bytes,
          originalName: "renamed.mp3",
          storageKey: `distribution/masters/${randomUUID()}`,
        },
      }),
    ).rejects.toThrow("DUPLICATE_MASTER");
    await expect(
      repository.addVersion(ctx, first.id, { expectedRevision: first.revision, asset: bytes }),
    ).rejects.toThrow("DUPLICATE_MASTER");
    await expect(
      repository.create(other, {
        ...input,
        asset: { ...bytes, storageKey: `distribution/masters/${randomUUID()}` },
      }),
    ).resolves.toMatchObject({ isTest: false });
    const concurrent = { ...input, asset: asset() };
    const results = await Promise.allSettled([
      repository.create(ctx, concurrent),
      repository.create(ctx, concurrent),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe("DUPLICATE_MASTER");
  });
  it("DS-DIST-R1 library search is literal, paged and world-scoped", async () => {
    const item = await repository.create(ctx, {
      title: "Literal 50%_Master",
      language: "en",
      category: "bhajans",
      asset: asset(),
    });
    expect((await repository.list(ctx, { query: "50%_" })).map((value) => value.id)).toEqual([
      item.id,
    ]);
    expect(await repository.list(other, { query: "50%_" })).toEqual([]);
    expect(await repository.list(ctx, { query: "50%_", state: "APPROVED" })).toEqual([]);
  });
  it("filters withdrawn sources before pagination while retaining accessible history and world isolation", async () => {
    const query = `Archive pagination ${randomUUID()}`;
    const makeSource = (context = ctx) =>
      repository.create(context, {
        title: query,
        language: "en",
        category: "bhajans",
        asset: asset(),
      });
    const firstActive = await makeSource();
    const secondActive = await makeSource();
    await repository.attestRights(ctx, secondActive.id, {
      expectedRevision: secondActive.revision,
      rights,
    });
    const firstWithdrawn = await makeSource();
    const secondWithdrawn = await makeSource();
    for (const source of [firstWithdrawn, secondWithdrawn])
      await repository.withdraw(reviewer, source.id, { expectedRevision: source.revision });
    const otherActive = await makeSource(other);
    const otherWithdrawn = await makeSource(other);
    await repository.withdraw({ ...reviewer, isTest: false }, otherWithdrawn.id, {
      expectedRevision: otherWithdrawn.revision,
    });
    const activePages = await Promise.all(
      [0, 1, 2].map((offset) =>
        repository.list(ctx, { archive: "active", query, limit: 1, offset }),
      ),
    );
    expect(activePages.map((page) => page.length)).toEqual([1, 1, 0]);
    expect(
      activePages
        .flat()
        .map((source) => source.id)
        .sort(),
    ).toEqual([firstActive.id, secondActive.id].sort());
    expect(
      activePages
        .flat()
        .map((source) => source.state)
        .sort(),
    ).toEqual(["DRAFT", "RIGHTS_CLEARED"]);
    const withdrawnPages = await Promise.all(
      [0, 1, 2].map((offset) =>
        repository.list(ctx, { archive: "withdrawn", query, limit: 1, offset }),
      ),
    );
    expect(withdrawnPages.map((page) => page.length)).toEqual([1, 1, 0]);
    expect(
      withdrawnPages
        .flat()
        .map((source) => source.id)
        .sort(),
    ).toEqual([firstWithdrawn.id, secondWithdrawn.id].sort());
    expect(await repository.list(ctx, { query })).toHaveLength(4);
    expect(await repository.list(ctx, { archive: "all", query })).toHaveLength(4);
    expect(
      (await repository.list(other, { archive: "active", query })).map((source) => source.id),
    ).toEqual([otherActive.id]);
    expect(
      (await repository.list(other, { archive: "withdrawn", query })).map((source) => source.id),
    ).toEqual([otherWithdrawn.id]);
    expect((await repository.get(ctx, firstWithdrawn.id)).state).toBe("WITHDRAWN");
    expect(await repository.versions(ctx, firstWithdrawn.id)).toHaveLength(1);
    expect(await repository.list(ctx, { archive: "withdrawn", query, state: "APPROVED" })).toEqual(
      [],
    );
  });

  it("imports linked masters atomically, reuses links/hashes, and retains source provenance without assuming rights", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const input = {
      url: "https://youtu.be/g0zlErdfXlg?t=3",
      language: "te",
      category: "pravachanams",
    };
    const first = await imports.enqueue(ctx, input);
    const duplicate = await imports.enqueue(ctx, {
      ...input,
      url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
    });
    expect(duplicate.id).toBe(first.id);
    expect(await imports.list(other)).toEqual([]);
    const claim = await imports.claim(true);
    expect(claim?.id).toBe(first.id);
    if (!claim) throw Error("missing claim");
    const bytes = asset();
    const saved = await imports.complete(claim, { asset: bytes, title: "Online teaching" });
    const master = await repository.get(ctx, saved.masterId);
    expect(master).toMatchObject({
      state: "DRAFT",
      rights: null,
      sourceUrl: "https://www.youtube.com/watch?v=g0zlErdfXlg",
    });
    await expect(imports.complete(claim, { asset: asset(), title: "stale" })).rejects.toThrow(
      "ONLINE_IMPORT_LEASE_LOST",
    );
    const second = await imports.enqueue(ctx, {
      ...input,
      url: "https://youtube.com/watch?v=N2Ni4WMEQJE",
    });
    const otherClaim = await imports.claim(true);
    expect(otherClaim?.id).toBe(second.id);
    if (!otherClaim) throw Error("missing claim");
    expect(
      await imports.complete(otherClaim, {
        asset: { ...bytes, storageKey: `distribution/masters/${randomUUID()}` },
        title: "Same bytes",
      }),
    ).toEqual({ masterId: saved.masterId, duplicate: true });
    await expect(
      imports.enqueue({ ...ctx, userId: "unauthorized@example.test", roles: [] }, input),
    ).rejects.toThrow("FORBIDDEN");
    await repository.addVersion(ctx, master.id, {
      expectedRevision: master.revision,
      asset: asset(),
    });
    expect((await repository.get(ctx, master.id)).sourceUrl).toBeUndefined();
    await imports.enqueue(ctx, { ...input, url: "https://youtube.com/watch?v=T9Oq-iv8KYo" });
    const oldSource = await imports.claim(true);
    if (!oldSource) throw Error("missing claim");
    await expect(
      imports.complete(oldSource, { asset: bytes, title: "Earlier source" }),
    ).rejects.toThrow("ONLINE_SOURCE_PREVIOUS_VERSION");
    await imports.fail(oldSource, "ONLINE_SOURCE_PREVIOUS_VERSION");
  });
  it("expands playlists into independent retryable imports and rechecks current Curator access", async () => {
    let authorized = true;
    const imports = createOnlineImportRepository(runtime, async () => authorized);
    const input = {
      url: "https://youtube.com/playlist?list=PLtest_playlist_sources",
      includePlaylist: true,
      language: "te",
      category: "pravachanams",
    };
    const parent = await imports.enqueue(ctx, input);
    const claim = await imports.claim(true);
    if (!claim) throw Error("missing claim");
    expect(claim.id).toBe(parent.id);
    const source = (id: string) => ({
      provider: "youtube" as const,
      kind: "video" as const,
      id,
      url: `https://www.youtube.com/watch?v=${id}`,
    });
    await imports.expand(claim, [source("T3DMGIreVN4"), source("yOXmC3kuueI")], "Playlist");
    const child = await imports.claim(true);
    if (!child) throw Error("missing child");
    await imports.fail(child, "ONLINE_SOURCE_RESTRICTED");
    authorized = false;
    expect(await imports.claim(true)).toBeNull();
    const rows = await imports.list(ctx);
    expect(rows.find((i) => i.id === parent.id)?.childIds).toHaveLength(2);
    expect(
      rows
        .filter((i) => i.parentId === parent.id)
        .map((i) => i.error)
        .sort(),
    ).toEqual(["ONLINE_IMPORT_FORBIDDEN", "ONLINE_SOURCE_RESTRICTED"]);
    authorized = true;
    await imports.retry(ctx, child.id);
    const retry = await imports.claim(true);
    if (!retry) throw Error("missing retry");
    authorized = false;
    await expect(imports.complete(retry, { asset: asset(), title: "Revoked" })).rejects.toThrow(
      "ONLINE_IMPORT_FORBIDDEN",
    );
    authorized = true;
    await migration.query(
      "UPDATE distribution.online_import SET lease_until=now()-interval '1 second' WHERE id=$1",
      [retry.id],
    );
    const recovered = await imports.claim(true);
    if (!recovered) throw Error("missing recovery");
    expect(recovered.leaseToken).not.toBe(retry.leaseToken);
    await expect(imports.complete(retry, { asset: asset(), title: "Old worker" })).rejects.toThrow(
      "ONLINE_IMPORT_LEASE_LOST",
    );
    await imports.fail(recovered, "ONLINE_SOURCE_UNAVAILABLE");
    expect((await imports.list(ctx)).find((item) => item.id === recovered.id)?.status).toBe(
      "QUEUED",
    );
    expect(await imports.claim(true)).toBeNull();
    await migration.query(
      "UPDATE distribution.online_import SET lease_until=now()-interval '1 second' WHERE id=$1",
      [recovered.id],
    );
    const finalAttempt = await imports.claim(true);
    if (!finalAttempt) throw Error("missing final attempt");
    await imports.fail(finalAttempt, "ONLINE_SOURCE_UNAVAILABLE");
    expect((await imports.list(ctx)).find((item) => item.id === recovered.id)?.status).toBe(
      "FAILED",
    );
  });
  it("stops a nonexistent playlist immediately without blocking other provider imports", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const parent = await imports.enqueue(ctx, {
      url: "https://youtube.com/playlist?list=PLmissing_playlist_source",
      includePlaylist: true,
      language: "te",
      category: "pravachanams",
    });
    const claim = await imports.claim(true);
    if (!claim) throw Error("missing claim");
    expect(claim.id).toBe(parent.id);
    await imports.fail(claim, "ONLINE_PLAYLIST_NOT_FOUND");
    const failed = (await imports.list(ctx)).find((item) => item.id === parent.id);
    expect(failed).toMatchObject({
      status: "FAILED",
      error: "ONLINE_PLAYLIST_NOT_FOUND",
      childIds: null,
      masterId: null,
    });
    expect(failed?.serviceIssue).toBeUndefined();
    expect(await imports.claim(true)).toBeNull();
    const next = await imports.enqueue(ctx, {
      url: "https://youtube.com/playlist?list=PLnext_playlist_source",
      includePlaylist: true,
      language: "te",
      category: "pravachanams",
    });
    const nextClaim = await imports.claim(true);
    expect(nextClaim?.id).toBe(next.id);
    if (nextClaim) await imports.fail(nextClaim, "ONLINE_PLAYLIST_NOT_FOUND");
  });
  it("pauses only an unfinished playlist, fences its old worker and resumes selected channels with saved analysis", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const studio = createIntelligentContentRepository(runtime, { authorize: async () => true });
    const parent = await imports.enqueueBundle(ctx, {
      title: "Editable channel plan",
      language: "te",
      category: "pravachanams",
      urls: [1, 2]
        .map(() => `https://youtube.com/watch?v=B${randomUUID().replaceAll("-", "").slice(0, 10)}`)
        .join("\n"),
    });
    const request = {
      channels: ["youtube"] as ("youtube" | "facebook")[],
      languages: ["en"] as "en"[],
      captions: true,
      instructions: "Complete teachings",
    };
    const setup = {
      rights: { ...rights, channels: ["youtube"] as ContentRights["channels"] },
      request,
    };
    await studio.configurePlaylist(ctx, parent.id, setup);
    const master = await create();
    const cleared = await repository.attestRights(ctx, master.id, {
      expectedRevision: master.revision,
      rights: setup.rights,
    });
    const pkg = await studio.create(ctx, {
      masterId: master.id,
      expectedSourceRevision: cleared.revision,
      request,
    });
    const plan = (await imports.list(ctx, { rootId: parent.id })).find(
      (i) => i.id === parent.id,
    )?.curation;
    if (!plan || !parent.childIds?.[0]) throw Error("missing playlist");
    plan.items[parent.childIds[0]] = { packageId: pkg.id, existing: false };
    await migration.query("UPDATE distribution.online_import SET curation=$2 WHERE id=$1", [
      parent.id,
      plan,
    ]);
    const jobId = (
      await migration.query(
        "SELECT id FROM distribution.studio_generation_job WHERE package_id=$1",
        [pkg.id],
      )
    ).rows[0].id;
    const claim = await studio.claimGeneration({ isTest: true, workerId: "pause-test", jobId });
    if (!claim) throw Error("missing claim");
    await studio.checkpointGeneration(claim, {
      progress: { phase: "transcription", provider: "sarvam", completed: 0, total: 1 },
    });
    await expect(studio.pausePlaylistSettings(ctx, parent.id)).rejects.toThrow(
      "PLAYLIST_PAUSE_WAIT",
    );
    expect(await studio.renewGeneration(claim)).toBe(true);
    await studio.checkpointGeneration(claim, {
      progress: {
        phase: "reviewing",
        provider: "gemini",
        completed: 0,
        total: 1,
        discoverySection: 27,
        discoverySections: 29,
      },
    });
    await studio.checkpointGeneration(claim, {
      key: "saved-analysis",
      fingerprint: "a".repeat(64),
      value: { complete: true },
    });
    const live = (await imports.list(ctx, { rootId: parent.id })).find(
      (item) => item.id === parent.id,
    );
    expect(live?.curation?.items[parent.childIds[0]]).toMatchObject({
      status: "GENERATING",
      outputCount: 0,
      generationProgress: { phase: "reviewing", discoverySection: 27, discoverySections: 29 },
    });
    expect(JSON.stringify(live)).not.toContain("saved-analysis");
    expect(await imports.list(other, { rootId: parent.id })).toEqual([]);
    await expect(studio.pausePlaylistSettings(reviewer, parent.id)).rejects.toThrow("FORBIDDEN");
    await expect(studio.pausePlaylistSettings(other, parent.id)).rejects.toThrow(
      "PLAYLIST_NOT_READY",
    );
    await studio.pausePlaylistSettings(ctx, parent.id);
    await studio.pausePlaylistSettings(ctx, parent.id);
    expect(await studio.renewGeneration(claim)).toBe(false);
    expect(
      await studio.claimGeneration({ isTest: true, workerId: "stale-worker", jobId }),
    ).toBeNull();
    const paused = await studio.get(ctx, pkg.id);
    expect(paused.status).toBe("DRAFT");
    const pausedPlan = (await imports.list(ctx, { rootId: parent.id })).find(
      (item) => item.id === parent.id,
    );
    expect(pausedPlan?.curation?.items[parent.childIds[0]]?.generationProgress).toBeNull();
    await expect(
      studio.enqueueGeneration(ctx, pkg.id, { expectedRevision: paused.revision }),
    ).rejects.toThrow("PLAYLIST_SETTINGS_PAUSED");
    expect(
      (await imports.list(ctx, { rootId: parent.id })).find((i) => i.id === parent.id)?.curation
        ?.pausedForSettings,
    ).toBe(true);
    const revised = {
      ...setup,
      rights: { ...setup.rights, channels: ["youtube", "facebook"] as ContentRights["channels"] },
      request: { ...request, channels: ["youtube", "facebook"] as ("youtube" | "facebook")[] },
    };
    await studio.configurePlaylist(ctx, parent.id, revised);
    const resumed = await studio.get(ctx, pkg.id);
    expect(resumed.request.channels).toEqual(["youtube", "facebook"]);
    expect(resumed.id).toBe(pkg.id);
    expect(resumed.outputs).toEqual([]);
    expect((await repository.get(ctx, master.id)).rights?.channels).toEqual([
      "youtube",
      "facebook",
    ]);
    const latest = (
      await migration.query(
        "SELECT id FROM distribution.studio_generation_job WHERE package_id=$1 ORDER BY package_revision DESC LIMIT 1",
        [pkg.id],
      )
    ).rows[0].id;
    const next = await studio.claimGeneration({ isTest: true, workerId: "resumed", jobId: latest });
    expect(next?.checkpoint?.["saved-analysis"]?.value).toEqual({ complete: true });
    if (next) await studio.failGeneration(next, "SYNTHETIC_TEST_END");
    const restored = (await imports.list(ctx, { rootId: parent.id })).find(
      (i) => i.id === parent.id,
    )?.curation;
    expect(restored?.pausedForSettings).toBeUndefined();
    expect(Object.keys(restored?.items ?? {})).toHaveLength(1);
    await migration.query(
      "UPDATE distribution.studio_revision SET snapshot=jsonb_set(snapshot,'{status}','\"IN_REVIEW\"') WHERE package_id=$1 AND revision=$2",
      [pkg.id, (await studio.get(ctx, pkg.id)).revision],
    );
    await expect(studio.pausePlaylistSettings(ctx, parent.id)).rejects.toThrow(
      "PLAYLIST_SETTINGS_LOCKED",
    );
    await migration.query(
      "UPDATE distribution.online_import SET deleted_at=now() WHERE id=ANY($1::uuid[])",
      [[parent.id, ...parent.childIds]],
    );
  });
  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    "curates all 16 members with shared setup; alternate branding=%s, pasted series=%s",
    async (alternateBranding, bundle) => {
      const imports = createOnlineImportRepository(runtime, async () => true);
      let authorized = true;
      const studio = createIntelligentContentRepository(runtime, {
        authorize: async () => authorized,
      });
      const input = { language: "te", category: "pravachanams" };
      const sources = Array.from({ length: 16 }, () => {
        const id = `B${randomUUID().replaceAll("-", "").slice(0, 10)}`;
        return {
          provider: "youtube" as const,
          kind: "video" as const,
          id,
          url: `https://www.youtube.com/watch?v=${id}`,
        };
      });
      const independent = await imports.enqueue(ctx, {
        ...input,
        url: sources[0]?.url ?? "missing",
      });
      const bundleInput = {
        ...input,
        title: "Sixteen teachings",
        urls: sources.map((s) => s.url).join("\n"),
      };
      const parent = bundle
        ? await imports.enqueueBundle(ctx, bundleInput)
        : await imports.enqueue(ctx, {
            ...input,
            url: `https://www.youtube.com/playlist?list=PL${randomUUID().replaceAll("-", "")}`,
            includePlaylist: true,
          });
      if (bundle) {
        expect((await imports.enqueueBundle(ctx, bundleInput)).id).toBe(parent.id);
        await expect(imports.enqueueBundle(reviewer, bundleInput)).rejects.toThrow("FORBIDDEN");
        await expect(
          imports.enqueueBundle(ctx, {
            ...bundleInput,
            urls: `${bundleInput.urls}\nhttps://localhost/private`,
          }),
        ).rejects.toThrow("UNSUPPORTED_VIDEO_LINK");
        expect(parent.status).toBe("COMPLETE");
        expect(parent.source.kind).toBe("bundle");
      }
      const claimFor = async (item: OnlineImport) => {
        const leaseToken = randomUUID();
        await migration.query(
          "UPDATE distribution.online_import SET status='DOWNLOADING',lease_token=$2,lease_until=now()+interval '2 minutes' WHERE id=$1",
          [item.id, leaseToken],
        );
        return { ...item, ...input, isTest: true, requestedBy: ctx.userId, leaseToken };
      };
      if (!bundle) await imports.expand(await claimFor(parent), sources, "Sixteen teachings");
      const playlist = (await imports.list(ctx)).find((item) => item.id === parent.id);
      expect(playlist?.childIds).toHaveLength(16);
      expect(playlist?.childIds?.[0]).toBe(independent.id);
      expect(
        (await imports.list(ctx)).find((item) => item.id === independent.id)?.parentId,
      ).toBeNull();
      const setup = {
        rights: { ...rights, channels: ["youtube", "facebook"] as ContentRights["channels"] },
        request: {
          languages: ["en"] as const,
          channels: alternateBranding ? (["youtube"] as const) : (["youtube", "facebook"] as const),
          ...(alternateBranding
            ? {
                sourceBranding: "bala-swamiji" as const,
                youtubeClosing: {
                  label: "Gurubhavana ADPT",
                  url: "https://www.youtube.com/@gurubhavanaadpt",
                },
              }
            : {}),
          captions: true,
          instructions: "Complete teachings",
          allCompleteMessages: true,
        },
      };
      const request = {
        ...setup.request,
        languages: [...setup.request.languages],
        channels: [...setup.request.channels],
      };
      await expect(
        studio.configurePlaylist(reviewer, parent.id, { ...setup, request }),
      ).rejects.toThrow("FORBIDDEN");
      await expect(
        studio.configurePlaylist(other, parent.id, { ...setup, request }),
      ).rejects.toThrow("PLAYLIST_NOT_READY");
      await expect(studio.configurePlaylist(ctx, parent.id, { rights, request })).rejects.toThrow(
        "PLAYLIST_PERMISSIONS_INVALID",
      );
      await studio.configurePlaylist(ctx, parent.id, { ...setup, request });
      await studio.configurePlaylist(ctx, parent.id, { ...setup, request });
      await expect(
        studio.configurePlaylist(ctx, parent.id, {
          ...setup,
          request: { ...request, captions: false },
        }),
      ).rejects.toThrow("PLAYLIST_ALREADY_STARTED");
      expect(await studio.queuePlaylistMember(true)).toBe(false);
      const members = (await imports.list(ctx)).filter((item) =>
        playlist?.childIds?.includes(item.id),
      );
      const first = await imports.complete(await claimFor(independent), {
        asset: asset(),
        title: "Existing approved curation",
      });
      let master = await repository.get(ctx, first.masterId);
      master = await repository.attestRights(ctx, master.id, {
        expectedRevision: master.revision,
        rights: setup.rights,
      });
      const prior = await studio.create(ctx, {
        masterId: master.id,
        expectedSourceRevision: master.revision,
        request,
      });
      // Existing approved snapshot is a fixture; the batch must never revise it or its source.
      await migration.query(
        "UPDATE distribution.studio_revision SET snapshot=jsonb_set(snapshot,'{status}','\"APPROVED\"') WHERE package_id=$1",
        [prior.id],
      );
      for (const member of members.filter((item) => item.id !== independent.id).slice(0, 14))
        await imports.complete(await claimFor(member), { asset: asset(), title: member.source.id });
      const last = members.find((item) => item.id === playlist?.childIds?.[15]);
      if (!last) throw Error("missing last");
      // Pick the member which was not completed, regardless of repository listing order.
      const waiting = (await imports.list(ctx)).find(
        (item) => playlist?.childIds?.includes(item.id) && item.status !== "COMPLETE",
      );
      if (!waiting) throw Error("missing waiting");
      await imports.fail(await claimFor(waiting), "ONLINE_SOURCE_TOO_LARGE");
      await Promise.all([studio.queuePlaylistMember(true), studio.queuePlaylistMember(true)]);
      for (;;) {
        const pending = await migration.query(
          "SELECT count(*)::int n FROM distribution.studio_generation_job WHERE is_test=true AND status IN ('QUEUED','RUNNING')",
        );
        expect(pending.rows[0].n).toBeLessThanOrEqual(2);
        // Simulate the generation worker draining each small queue before scheduling more members.
        await migration.query(
          "UPDATE distribution.studio_generation_job SET status='SUCCEEDED' WHERE is_test=true AND status='QUEUED'",
        );
        if (!(await studio.queuePlaylistMember(true))) break;
      }
      let plan = (await imports.list(ctx)).find((item) => item.id === parent.id)?.curation;
      expect(Object.keys(plan?.items ?? {})).toHaveLength(15);
      expect(plan?.items[independent.id]).toMatchObject({
        packageId: prior.id,
        existing: true,
        status: "APPROVED",
      });
      expect((await repository.get(ctx, first.masterId)).revision).toBe(master.revision);
      expect((await studio.get(ctx, prior.id)).revision).toBe(prior.revision);
      await imports.retry(ctx, waiting.id);
      await imports.complete(await claimFor(waiting), {
        asset: { ...asset(), byteSize: 600 * 1024 * 1024 },
        title: "Large complete teaching",
      });
      authorized = false;
      expect(await studio.queuePlaylistMember(true)).toBe(true);
      expect(
        (await imports.list(ctx)).find((item) => item.id === parent.id)?.curation?.items[
          waiting.id
        ],
      ).toEqual({ error: "ONLINE_IMPORT_FORBIDDEN" });
      authorized = true;
      await studio.retryPlaylistItem(ctx, parent.id, waiting.id);
      expect(await studio.queuePlaylistMember(true)).toBe(true);
      expect(await studio.queuePlaylistMember(true)).toBe(false);
      plan = (await imports.list(ctx)).find((item) => item.id === parent.id)?.curation;
      expect(Object.values(plan?.items ?? {}).filter((value) => value.packageId)).toHaveLength(16);
      for (const child of await studio.list(ctx, { playlistId: parent.id })) {
        expect(child.request.youtubeClosing).toEqual(request.youtubeClosing);
        expect(child.request.sourceBranding).toEqual(request.sourceBranding);
      }
      expect(new Set(Object.values(plan?.items ?? {}).map((value) => value.packageId)).size).toBe(
        16,
      );
      expect(
        (await studio.list(ctx, { playlistId: parent.id })).map((pkg) => pkg.id).sort(),
      ).toEqual(
        Object.values(plan?.items ?? {})
          .map((member) => member.packageId)
          .sort(),
      );
      for (const member of (await imports.list(ctx)).filter((item) =>
        playlist?.childIds?.includes(item.id),
      )) {
        const saved = await repository.get(ctx, member.masterId as string);
        expect(saved.rights).toEqual(setup.rights);
        const audits = await migration.query(
          "SELECT count(*)::int AS n FROM distribution.audit_event WHERE master_id=$1 AND action='RIGHTS_ATTESTED'",
          [saved.id],
        );
        expect(audits.rows[0].n).toBe(1);
      }
      await expect(studio.retryPlaylistItem(ctx, parent.id, independent.id)).rejects.toThrow(
        "NOT_FOUND",
      );
      const failedId = Object.values(plan?.items ?? {}).find(
        (member) => !member.existing,
      )?.packageId;
      if (!failedId) throw Error("missing generated member");
      const job = (
        await migration.query(
          "SELECT id FROM distribution.studio_generation_job WHERE package_id=$1 ORDER BY package_revision DESC LIMIT 1",
          [failedId],
        )
      ).rows[0];
      await migration.query(
        "UPDATE distribution.studio_generation_job SET status='QUEUED' WHERE id=$1",
        [job.id],
      );
      const claim = await studio.claimGeneration({
        isTest: true,
        workerId: "playlist-retry-test",
        jobId: job.id,
      });
      if (!claim) throw Error("missing generation claim");
      const failureCode = bundle ? "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT" : "STUDIO_PROVIDER_TIMEOUT";
      await studio.failGeneration(claim, failureCode);
      const failed = await studio.get(ctx, failedId);
      expect(failed.status).toBe("FAILED");
      expect(failed.failure).toBe(failureCode);
      await expect(studio.retryPlaylistGeneration(reviewer, parent.id)).rejects.toThrow(
        "FORBIDDEN",
      );
      await expect(studio.retryPlaylistGeneration(other, parent.id)).rejects.toThrow("NOT_FOUND");
      authorized = false;
      await expect(studio.retryPlaylistGeneration(ctx, parent.id)).rejects.toThrow(
        "ONLINE_IMPORT_FORBIDDEN",
      );
      authorized = true;
      await studio.retryPlaylistGeneration(ctx, parent.id);
      expect(await studio.get(ctx, failedId)).toMatchObject({
        status: "QUEUED",
        revision: failed.revision + 1,
      });
      await studio.retryPlaylistGeneration(ctx, parent.id);
      expect((await studio.get(ctx, failedId)).revision).toBe(failed.revision + 1);
      expect((await studio.get(ctx, prior.id)).revision).toBe(prior.revision);
      // This parameterized fixture owns these jobs; drain them before the next independent bundle.
      const retryJob = (
        await migration.query(
          "SELECT id FROM distribution.studio_generation_job WHERE package_id=$1 AND status='QUEUED' ORDER BY package_revision DESC LIMIT 1",
          [failedId],
        )
      ).rows[0];
      const retryClaim = await studio.claimGeneration({
        isTest: true,
        workerId: "suitability-test",
        jobId: retryJob.id,
      });
      if (!retryClaim) throw Error("missing retry claim");
      const progress = {
        phase: "drafting" as const,
        provider: "gemini" as const,
        completed: 1,
        total: 1,
        excludedChannels: [
          { channel: "youtube" as const, reason: "Only music; no complete teaching." },
        ],
      };
      // A failed authority service must not mask a source assessment already made.
      authorized = false;
      await studio.failGeneration(retryClaim, "STUDIO_NO_SUITABLE_CHANNELS", progress);
      authorized = true;
      const unsuitable = await studio.get(ctx, failedId);
      expect(unsuitable).toMatchObject({
        status: "FAILED",
        generationProgress: { ...progress, errorCode: "STUDIO_NO_SUITABLE_CHANNELS" },
      });
      await expect(studio.failGeneration(retryClaim, "GENERATION_FAILED")).rejects.toThrow(
        "STUDIO_LEASE_LOST",
      );
      await studio.retryPlaylistGeneration(ctx, parent.id);
      expect(await studio.get(ctx, failedId)).toMatchObject({
        status: "FAILED",
        revision: unsuitable.revision,
        failure: "STUDIO_NO_SUITABLE_CHANNELS",
      });
      expect(
        (await imports.list(ctx)).find((item) => item.id === parent.id)?.curation?.items,
      ).toMatchObject({
        [Object.keys(plan?.items ?? {}).find(
          (key) => plan?.items[key]?.packageId === failedId,
        ) as string]: { error: "STUDIO_NO_SUITABLE_CHANNELS" },
      });
      await migration.query(
        "UPDATE distribution.studio_generation_job SET status='SUCCEEDED' WHERE package_id=ANY($1::uuid[]) AND status='QUEUED'",
        [(await studio.list(ctx, { playlistId: parent.id })).map((pkg) => pkg.id)],
      );
    },
  );
  it("pauses a provider after one bot challenge, preserves the bundle and resumes only on one explicit recovery action", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const parent = await imports.enqueue(ctx, {
      url: `https://www.youtube.com/playlist?list=PL${randomUUID().replaceAll("-", "")}`,
      includePlaylist: true,
      language: "te",
      category: "pravachanams",
    });
    const reading = await imports.claim(true);
    if (!reading) throw Error("missing playlist claim");
    expect(reading.id).toBe(parent.id);
    const sources = Array.from({ length: 16 }, () => {
      const id = `C${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      return {
        provider: "youtube" as const,
        kind: "video" as const,
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    });
    await imports.expand(reading, sources, "One bundle");
    // This recovery scenario represents a playlist whose shared curation setup is already saved.
    await migration.query("UPDATE distribution.online_import SET curation=$2 WHERE id=$1", [
      parent.id,
      { items: {}, requestedBy: ctx.userId },
    ]);
    const first = await imports.claim(true);
    if (!first) throw Error("missing member");
    // A rolling deployment cannot send another concurrent request to this provider.
    expect(await imports.claim(true)).toBeNull();
    await imports.fail(first, "ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    expect(await imports.claim(true)).toBeNull();
    const rows = await imports.list(ctx);
    const bundle = rows.find((i) => i.id === parent.id);
    expect(bundle?.serviceIssue).toMatchObject({
      code: "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
      retryAt: null,
    });
    const members = rows.filter((i) => bundle?.childIds?.includes(i.id));
    expect(members).toHaveLength(16);
    expect(members.every((i) => i.status === "QUEUED")).toBe(true);
    expect(
      members.every((i) => i.serviceIssue?.code === "ONLINE_PROVIDER_VERIFICATION_REQUIRED"),
    ).toBe(true);
    expect((await imports.list(other)).every((i) => !i.serviceIssue)).toBe(true);
    await expect(imports.retryPlaylist(reviewer, parent.id)).rejects.toThrow("FORBIDDEN");
    await expect(imports.retryPlaylist(other, parent.id)).rejects.toThrow("NOT_FOUND");
    await expect(imports.retry(reviewer, first.id)).rejects.toThrow("FORBIDDEN");
    await expect(
      createOnlineImportRepository(runtime, async () => false).retry(ctx, first.id),
    ).rejects.toThrow("ONLINE_IMPORT_FORBIDDEN");
    await imports.retry(ctx, first.id);
    const singleRetry = await imports.claim(true);
    if (!singleRetry) throw Error("missing single-recording recovery");
    await imports.fail(singleRetry, "ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    expect(await imports.claim(true)).toBeNull();
    await imports.retryPlaylist(ctx, parent.id);
    const retry = await imports.claim(true);
    if (!retry) throw Error("missing recovery claim");
    // An old worker response must not re-block a provider after recovery.
    await imports.fail(first, "ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    expect((await imports.list(ctx)).find((i) => i.id === parent.id)?.serviceIssue).toBeUndefined();
    await imports.complete(retry, { asset: asset(), title: "Recovered recording" });
    const second = await imports.claim(true);
    if (!second) throw Error("missing next member");
    await imports.fail(second, "ONLINE_PROVIDER_RATE_LIMITED");
    expect(await imports.claim(true)).toBeNull();
    expect(
      (await imports.list(ctx)).find((i) => i.id === parent.id)?.serviceIssue?.retryAt,
    ).toBeTruthy();
    await migration.query(
      "UPDATE distribution.online_import_service SET retry_at=now()-interval '1 second' WHERE is_test=true AND provider='youtube'",
    );
    const automatic = await imports.claim(true);
    if (!automatic) throw Error("missing automatic rate-limit recovery");
    await imports.complete(automatic, { asset: asset(), title: "Provider available again" });
    expect((await imports.list(ctx)).find((i) => i.id === parent.id)?.serviceIssue).toBeUndefined();
    await imports.retryPlaylist(ctx, parent.id);
    expect(
      (await imports.list(ctx)).filter((i) => i.masterId && bundle?.childIds?.includes(i.id)),
    ).toHaveLength(2);
  });
  it("attaches originals inside a playlist, cancels stale download leases, preserves its plan and refuses overwrites", async () => {
    const imports = createOnlineImportRepository(runtime, async () => true);
    const playlist = await imports.enqueue(ctx, {
      url: `https://www.youtube.com/playlist?list=PL${randomUUID().replaceAll("-", "")}`,
      includePlaylist: true,
      language: "te",
      category: "pravachanams",
    });
    const claim = await imports.claimVerification(ctx, playlist.id);
    const sources = Array.from({ length: 2 }, (_, index) => {
      const id = randomUUID().replaceAll("-", "").slice(0, 11);
      return {
        provider: "youtube" as const,
        kind: "video" as const,
        id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: `Original ${index}`,
      };
    });
    await imports.expand(claim, sources, "Upload recovery");
    const bundle = (await imports.recoveryTarget(ctx, playlist.id)).root;
    const [first, second] = bundle.childIds ?? [];
    if (!first || !second) throw Error("missing children");
    const download = await imports.claimVerification(ctx, playlist.id);
    await imports.fail(download, "ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    const plan = {
      rights,
      requestedBy: ctx.userId,
      confirmedAt: new Date().toISOString(),
      request: { channels: ["youtube_short"], languages: ["en"], captions: true },
      items: { [first]: { error: "ONLINE_SOURCE_RESTRICTED" } },
    };
    await migration.query("UPDATE distribution.online_import SET curation=$2 WHERE id=$1", [
      playlist.id,
      plan,
    ]);
    const original = { asset: asset(), title: "Recovered original" };
    await expect(imports.attachOriginal(reviewer, playlist.id, first, original)).rejects.toThrow(
      "FORBIDDEN",
    );
    await expect(imports.attachOriginal(other, playlist.id, first, original)).rejects.toThrow(
      "ORIGINAL_NOT_IN_PLAYLIST",
    );
    await expect(imports.attachOriginal(ctx, playlist.id, randomUUID(), original)).rejects.toThrow(
      "ORIGINAL_NOT_IN_PLAYLIST",
    );
    const [one, two] = await Promise.all([
      imports.attachOriginal(ctx, playlist.id, first, original),
      imports.attachOriginal(ctx, playlist.id, first, original),
    ]);
    expect(one.masterId).toBe(two.masterId);
    expect([one.duplicate, two.duplicate].sort()).toEqual([false, true]);
    await expect(
      imports.complete(download, { asset: asset(), title: "Stale network result" }),
    ).rejects.toThrow("ONLINE_IMPORT_LEASE_LOST");
    const saved = await repository.get(ctx, one.masterId);
    expect(saved.title).toBe(sources[0]?.title);
    expect((await imports.list(ctx)).find((item) => item.id === first)?.title).toBe(
      sources[0]?.title,
    );
    await expect(
      imports.attachOriginal(ctx, playlist.id, first, {
        asset: asset(),
        title: "Sneak in changes",
      }),
    ).rejects.toThrow("ORIGINAL_ALREADY_ATTACHED");
    expect((await repository.get(ctx, one.masterId)).revision).toBe(saved.revision);
    const retained = (await imports.recoveryTarget(ctx, playlist.id)).root;
    expect(retained.curation).toEqual({ ...plan, items: {} });
    expect((await imports.recoveryTarget(ctx, playlist.id)).target?.id).toBe(second);
    expect(
      (await imports.list(ctx)).find((item) => item.id === playlist.id)?.serviceIssue?.code,
    ).toBe("ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    const attached = await imports.attachOriginal(ctx, playlist.id, second, original);
    expect(attached).toEqual({ masterId: one.masterId, duplicate: true });
    expect((await imports.recoveryTarget(ctx, playlist.id)).target).toBeNull();
    await expect(imports.claimVerification(ctx, playlist.id)).rejects.toThrow(
      "VERIFICATION_NOT_NEEDED",
    );
  });
  beforeAll(async () => {
    const base = new URL(process.env.DISTRIBUTION_TEST_ADMIN_URL ?? "");
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      !base.pathname.startsWith("/content_studio_separation_test_")
    )
      throw new Error("LOCAL_DATABASE_REQUIRED");
    admin = new Pool({ connectionString: base.toString() });
    const migrationPassword = randomUUID();
    const runtimePassword = randomUUID();
    await admin.query(
      `CREATE ROLE ${migrateRole} LOGIN PASSWORD '${migrationPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(
      `CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`CREATE DATABASE ${database} OWNER ${migrateRole}`);
    const testAdminUrl = new URL(base);
    testAdminUrl.pathname = `/${database}`;
    const testAdmin = new Pool({ connectionString: testAdminUrl.toString() });
    try {
      await testAdmin.query(
        "REVOKE ALL ON SCHEMA public FROM PUBLIC; CREATE TABLE public.core_boundary_probe(id int)",
      );
    } finally {
      await testAdmin.end();
    }
    const migrationUrl = new URL(testAdminUrl);
    migrationUrl.username = migrateRole;
    migrationUrl.password = migrationPassword;
    migration = new Pool({ connectionString: migrationUrl.toString() });
    await migrate(drizzle(migration), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
      migrationsSchema: "distribution_migrations",
      migrationsTable: "__distribution_migrations",
    });
    const sql = (
      await readFile(new URL("../ops/runtime-grants.sql", import.meta.url), "utf8")
    ).replaceAll(":'distribution_runtime_role'", `'${runtimeRole}'`);
    await migration.query(sql);
    await provisionDistributionCapabilities(
      migration,
      ctx.userId,
      true,
      ["content.create", "content.review", "content.publish"],
      "local-test-bootstrap",
    );
    await provisionDistributionCapabilities(
      migration,
      ctx.userId,
      false,
      ["content.create", "content.review", "content.publish"],
      "local-test-bootstrap",
    );
    const runtimeUrl = new URL(testAdminUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 4 });
    repository = createDistributionRepository(runtime);
    editorial = createDistributionEditorialRepository(runtime);
  }, 20000);
  afterAll(async () => {
    await runtime?.end();
    await migration?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}; DROP ROLE IF EXISTS ${migrateRole}`);
      await admin.end();
    }
  });
  it("DS-DIST-R1-AUTH runtime cannot grant itself capabilities or read core", async () => {
    await expect(runtime.query("SELECT * FROM public.core_boundary_probe")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      provisionDistributionCapabilities(runtime, "intruder", true, ["content.publish"], "intruder"),
    ).rejects.toThrow(/permission denied/);
    await expect(
      repository.create(
        { userId: "ungranted@example.test", isTest: true },
        { title: "Denied", language: "en", category: "other", asset: asset() },
      ),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("requires an explicit Content Approver assignment even for an administrator with legacy content grants", async () => {
    let content = await create();
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights,
    });
    const administrator = {
      userId: "role-boundary-admin@example.test",
      isTest: true,
      roles: ["SUPER_ADMIN"],
    };
    await provisionDistributionCapabilities(
      migration,
      administrator.userId,
      true,
      ["content.create", "content.review", "content.publish"],
      "local-test",
    );
    await expect(
      repository.approve(administrator, content.id, { expectedRevision: content.revision }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      repository.approve(ctx, content.id, { expectedRevision: content.revision }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      repository.create(reviewer, {
        title: "Wrong role",
        language: "en",
        category: "other",
        asset: asset(),
      }),
    ).rejects.toThrow("FORBIDDEN");
    const assigned = { ...administrator, roles: [...administrator.roles, "CONTENT_APPROVER"] };
    content = await repository.approve(assigned, content.id, {
      expectedRevision: content.revision,
    });
    expect(content.approval?.reviewerId).toBe(assigned.userId);
    await expect(
      repository.getExport(administrator, content.id, {
        expectedRevision: content.revision,
        channel: "manual_export",
        territory: "WORLDWIDE",
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("DS-DIST-R1-CONTENT world isolation covers list read and mutations", async () => {
    const content = await create();
    expect((await repository.list(ctx)).some((item) => item.id === content.id)).toBe(true);
    expect((await repository.list(other)).some((item) => item.id === content.id)).toBe(false);
    await expect(repository.get(other, content.id)).rejects.toThrow("NOT_FOUND");
    await expect(
      repository.attestRights(other, content.id, { expectedRevision: 1, rights }),
    ).rejects.toThrow("NOT_FOUND");
  });
  it("DS-DIST-R1-CONTENT immutable master bytes and approval survive only exact reviewed version", async () => {
    let content = await create();
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights,
    });
    content = await repository.approve(reviewer, content.id, {
      expectedRevision: content.revision,
    });
    expect(content.approval?.approvedRevision).toBe(content.revision);
    const options = {
      expectedRevision: content.revision,
      channel: "manual_export" as const,
      territory: "US",
      now: new Date().toISOString(),
    };
    expect((await repository.getExport(reviewer, content.id, options)).asset.sha256).toBe(
      content.currentVersion.sha256,
    );
    await expect(
      runtime.query("UPDATE distribution.content_version SET sha256=$1 WHERE id=$2", [
        "b".repeat(64),
        content.currentVersion.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    content = await repository.addVersion(ctx, content.id, {
      expectedRevision: content.revision,
      asset: asset(),
    });
    expect(content.currentVersion.number).toBe(2);
    expect((await repository.versions(ctx, content.id)).map((version) => version.number)).toEqual([
      2, 1,
    ]);
    expect(content.approval).toBeNull();
    expect(content.rights).toBeNull();
    await expect(
      repository.getExport(reviewer, content.id, {
        ...options,
        expectedRevision: content.revision,
      }),
    ).rejects.toThrow("EXPORT_REFUSED:NOT_APPROVED");
  });
  it("DS-DIST-R1-CONTENT concurrent approval and rights change cannot approve stale rights", async () => {
    let content = await create();
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights,
    });
    const results = await Promise.allSettled([
      repository.approve(reviewer, content.id, { expectedRevision: content.revision }),
      repository.attestRights(ctx, content.id, {
        expectedRevision: content.revision,
        rights: { ...rights, owner: "Revised rights owner" },
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.message).toBe("REVISION_CONFLICT");
    const current = await repository.get(ctx, content.id);
    if (current.state === "APPROVED") expect(current.rights?.owner).toBe("SGS");
    else expect(current.approval).toBeNull();
  });
  it("DS-DIST-R1-EXPORT metadata changes invalidate approval and withdrawal blocks bytes", async () => {
    let content = await create();
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights,
    });
    content = await repository.approve(reviewer, content.id, {
      expectedRevision: content.revision,
    });
    content = await repository.updateMetadata(ctx, content.id, {
      expectedRevision: content.revision,
      title: "Reviewed title changed",
      language: "en",
      category: "bhajans",
    });
    expect(content.approval).toBeNull();
    expect(content.state).toBe("RIGHTS_CLEARED");
    content = await repository.withdraw(reviewer, content.id, {
      expectedRevision: content.revision,
    });
    await expect(repository.getAsset(ctx, content.id)).rejects.toThrow("CONTENT_WITHDRAWN");
    await expect(
      repository.getExport(reviewer, content.id, {
        expectedRevision: content.revision,
        channel: "manual_export",
        territory: "US",
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow("EXPORT_REFUSED:WITHDRAWN");
  });
  it("DS-DIST-R1-AUTH revoked capabilities take effect on the next command", async () => {
    const principal = {
      userId: "temporary-reviewer@example.test",
      isTest: true,
      roles: ["CONTENT_APPROVER"],
    };
    await provisionDistributionCapabilities(
      migration,
      principal.userId,
      true,
      ["content.review"],
      "local-test-bootstrap",
    );
    const content = await create();
    expect((await repository.get(principal, content.id)).id).toBe(content.id);
    await provisionDistributionCapabilities(
      migration,
      principal.userId,
      true,
      [],
      "local-test-bootstrap",
    );
    await expect(repository.get({ ...principal, roles: [] }, content.id)).rejects.toThrow(
      "FORBIDDEN",
    );
  });
  it("DS-DIST-R1-CONTENT database constraints refuse cross-world references and duplicate source writes roll back", async () => {
    const content = await create();
    const before = (await repository.list(ctx)).length;
    const original = await repository.getAsset(ctx, content.id);
    await expect(
      repository.create(ctx, {
        title: "Duplicate immutable asset",
        language: "en",
        category: "other",
        asset: original.asset,
      }),
    ).rejects.toThrow("DUPLICATE_MASTER");
    expect((await repository.list(ctx)).length).toBe(before);
    await expect(
      runtime.query(
        "INSERT INTO distribution.content_version(master_id,is_test,number,storage_key,sha256,byte_size,mime_type,original_name,created_by) VALUES ($1,false,1,$2,$3,123,'audio/mpeg','chant.mp3','probe')",
        [content.id, `distribution/masters/${randomUUID()}`, "a".repeat(64)],
      ),
    ).rejects.toThrow(/foreign key constraint/);
  });
  it("DS-DIST-R1-EXPORT stale export forms and expired rights are refused", async () => {
    let content = await create();
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights,
    });
    content = await repository.approve(reviewer, content.id, {
      expectedRevision: content.revision,
    });
    await expect(
      repository.getExport(reviewer, content.id, {
        expectedRevision: content.revision - 1,
        channel: "manual_export",
        territory: "US",
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow("REVISION_CONFLICT");
    content = await repository.attestRights(ctx, content.id, {
      expectedRevision: content.revision,
      rights: { ...rights, expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    await expect(
      repository.approve(reviewer, content.id, { expectedRevision: content.revision }),
    ).rejects.toThrow("APPROVAL_REFUSED:RIGHTS_EXPIRED");
  });
  const manual = {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-v1",
  };
  const createTranscript = async () => {
    const content = await create();
    const transcript = await editorial.createTranscript(ctx, content.id, {
      expectedSourceVersionId: content.currentVersion.id,
      language: "en",
      durationMs: 10000,
      segments: [
        {
          id: "one",
          startMs: 1000,
          endMs: 3000,
          originalText: "Practice daily.",
          displayText: "Practice daily.",
        },
        {
          id: "two",
          startMs: 4000,
          endMs: 6000,
          originalText: "Be kind.",
          displayText: "Be kind.",
        },
      ],
      provenance: manual,
    });
    return { content, transcript };
  };
  it("DS-DIST-R2-SOURCE corrections preserve original text and do not inherit approval", async () => {
    const { content, transcript } = await createTranscript();
    const approved = await editorial.reviewTranscript(reviewer, transcript.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    const corrected = await editorial.correctTranscript(ctx, transcript.id, {
      expectedRevision: approved.revision,
      corrections: [{ segmentId: "one", displayText: "Practise daily." }],
    });
    expect(corrected.parentVersionId).toBe(transcript.id);
    expect(corrected.review).toBeNull();
    expect(corrected.segments[0]?.originalText).toBe("Practice daily.");
    expect(corrected.segments[0]?.displayText).toBe("Practise daily.");
    expect((await editorial.getTranscript(ctx, transcript.id)).segments[0]?.displayText).toBe(
      "Practice daily.",
    );
    expect((await editorial.listTranscripts(ctx, content.id)).map((value) => value.number)).toEqual(
      [2, 1],
    );
    await expect(
      runtime.query("UPDATE distribution.transcript_version SET language='hi' WHERE id=$1", [
        transcript.id,
      ]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      editorial.reviewTranscript(reviewer, transcript.id, {
        expectedRevision: approved.revision,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("TRANSCRIPT_SUPERSEDED");
  });
  it("DS-DIST-R2-REVIEW overlapping corrections and overlapping decisions each have one winner", async () => {
    const first = await createTranscript();
    const changes = await Promise.allSettled([
      editorial.correctTranscript(ctx, first.transcript.id, {
        expectedRevision: 1,
        corrections: [{ segmentId: "one", displayText: "Daily practice." }],
      }),
      editorial.correctTranscript(ctx, first.transcript.id, {
        expectedRevision: 1,
        corrections: [{ segmentId: "one", displayText: "Practice each day." }],
      }),
    ]);
    expect(changes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const second = await createTranscript();
    const decisions = await Promise.allSettled([
      editorial.reviewTranscript(reviewer, second.transcript.id, {
        expectedRevision: 1,
        decision: "APPROVED",
      }),
      editorial.reviewTranscript(reviewer, second.transcript.id, {
        expectedRevision: 1,
        decision: "REJECTED",
      }),
    ]);
    expect(decisions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = decisions.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason.message).toBe("REVISION_CONFLICT");
  });
  it("DS-DIST-R2-QUOTE exact approved source alone can become an approved quote", async () => {
    const { transcript } = await createTranscript();
    const approved = await editorial.reviewTranscript(reviewer, transcript.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    const input = {
      transcriptVersionId: transcript.id,
      transcriptRevision: approved.revision,
      kind: "EXACT_QUOTE" as const,
      segmentIds: ["one"],
      startMs: 1000,
      endMs: 3000,
      text: "Practice daily.",
      provenance: manual,
    };
    await expect(
      editorial.createQuote(ctx, { ...input, text: "Always practise every day." }),
    ).rejects.toThrow("QUOTE_TEXT_MISMATCH");
    const exact = await editorial.createQuote(ctx, input);
    expect(exact.review).toBeNull();
    const reviewed = await editorial.reviewQuote(reviewer, exact.id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    expect(reviewed.review?.reviewerId).toBe(reviewer.userId);
    const summary = await editorial.createQuote(ctx, {
      ...input,
      kind: "SUMMARY",
      text: "Daily practice is recommended.",
    });
    await expect(
      editorial.reviewQuote(reviewer, summary.id, { expectedRevision: 1, decision: "APPROVED" }),
    ).rejects.toThrow("NOT_EXACT_QUOTE");
    await editorial.reviewTranscript(reviewer, transcript.id, {
      expectedRevision: approved.revision,
      decision: "REJECTED",
    });
    await expect(
      editorial.reviewQuote(reviewer, exact.id, {
        expectedRevision: reviewed.revision,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("TRANSCRIPT_NOT_APPROVED");
  });
  it("DS-DIST-R2-SOURCE source replacement or withdrawal blocks editorial commands", async () => {
    const { content, transcript } = await createTranscript();
    let changed = await repository.addVersion(ctx, content.id, {
      expectedRevision: content.revision,
      asset: asset(),
    });
    await expect(
      editorial.reviewTranscript(reviewer, transcript.id, {
        expectedRevision: 1,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("SOURCE_VERSION_STALE");
    changed = await repository.withdraw(reviewer, content.id, {
      expectedRevision: changed.revision,
    });
    await expect(
      editorial.createTranscript(ctx, changed.id, {
        expectedSourceVersionId: changed.currentVersion.id,
        language: "en",
        durationMs: 10000,
        segments: transcript.segments,
        provenance: manual,
      }),
    ).rejects.toThrow("CONTENT_WITHDRAWN");
  });
  it("DS-DIST-R2-SOURCE editorial readers and writers are isolated by identity and world", async () => {
    const { content, transcript } = await createTranscript();
    expect(await editorial.listTranscripts(other, content.id)).toEqual([]);
    await expect(editorial.getTranscript(other, transcript.id)).rejects.toThrow("NOT_FOUND");
    await expect(
      editorial.reviewTranscript({ ...reviewer, isTest: false }, transcript.id, {
        expectedRevision: 1,
        decision: "APPROVED",
      }),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      editorial.getTranscript({ userId: "unknown@example.test", isTest: true }, transcript.id),
    ).rejects.toThrow("FORBIDDEN");
  });
  it("DS-DIST-R2-GLOSSARY reviewed terms retain immutable history and never cross worlds", async () => {
    const entry = await editorial.addGlossary(reviewer, {
      term: "Ganapathi",
      preferred: "Ganapati",
      language: "sa",
    });
    const revised = await editorial.reviseGlossary(reviewer, entry.id, {
      term: "Ganapathi",
      preferred: "Gaṇapati",
      language: "sa",
    });
    expect((await editorial.listGlossary(ctx, "sa")).map((row) => row.id)).toEqual([revised.id]);
    expect(await editorial.listGlossary(other, "sa")).toEqual([]);
    const original = await runtime.query(
      "SELECT preferred FROM distribution.glossary_version WHERE id=$1",
      [entry.id],
    );
    expect(original.rows[0].preferred).toBe("Ganapati");
    await expect(
      editorial.reviseGlossary(reviewer, entry.id, {
        term: "Ganapathi",
        preferred: "Ganapati",
        language: "sa",
      }),
    ).rejects.toThrow("GLOSSARY_SUPERSEDED");
    await expect(
      runtime.query("DELETE FROM distribution.glossary_version WHERE id=$1", [entry.id]),
    ).rejects.toThrow(/permission denied/);
  });
});
