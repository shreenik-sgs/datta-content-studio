import {
  contentRightsSchema,
  studioGenerationRequestSchema,
} from "@satsang/distribution-contracts";
import {
  createIntelligentContentRepository,
  createOnlineImportRepository,
  createStudioRoleAuthority,
} from "@satsang/distribution-db";
import { ONLINE_IMPORT_ERRORS } from "@satsang/distribution-domain";
import { z } from "zod";
import { json, readBoundedBody, safeProblem } from "../../../../lib/http";
import { access, distributionPool } from "../../../../lib/runtime";
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("import-bundle"),
      urls: z.string().max(205000),
      title: z.string().trim().min(1).max(200),
      language: z.enum(["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"]),
      category: z.string().max(60),
    })
    .strict(),
  z
    .object({
      action: z.literal("import"),
      url: z.string().max(2048),
      includePlaylist: z.boolean().default(false),
      language: z.enum(["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"]),
      category: z.string().max(60),
    })
    .strict(),
  z.object({ action: z.literal("retry"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("resume-playlist"), id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.literal("curate-playlist"),
      id: z.string().uuid(),
      rights: contentRightsSchema,
      request: studioGenerationRequestSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal("retry-curation"),
      id: z.string().uuid(),
      childId: z.string().uuid(),
    })
    .strict(),
]);
function repository() {
  return createOnlineImportRepository(distributionPool(), createStudioRoleAuthority(process.env));
}
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const repo = repository();
    const query = z
      .object({
        rootId: z.string().uuid().optional(),
        masterId: z.string().uuid().optional(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .refine((value) => !value.masterId || (!value.rootId && value.offset === 0))
      .parse(Object.fromEntries(new URL(request.url).searchParams));
    if (query.masterId)
      return json({ bundles: await repo.bundlesForMaster(auth.context, query.masterId) });
    const items = await repo.list(auth.context, { ...query, summaries: !query.rootId });
    return json({
      items,
      groupedMasterIds: await repo.groupedMasters(auth.context),
      nextOffset: !query.rootId && items.length === 20 ? query.offset + 20 : null,
      available: await repo.ready(auth.context.isTest),
    });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    const data = schema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 220000))),
    );
    const repo = repository();
    if (!(await repo.ready(auth.context.isTest))) throw Error("ONLINE_IMPORT_DISABLED");
    if (data.action === "import-bundle")
      return json({ item: await repo.enqueueBundle(auth.context, data) }, 202);
    if (data.action === "resume-playlist") {
      await repo.retryPlaylist(auth.context, data.id);
      await createIntelligentContentRepository(distributionPool(), {
        authorize: createStudioRoleAuthority(process.env),
      }).retryPlaylistGeneration(auth.context, data.id);
      return json(
        {
          item: (await repo.list(auth.context, { rootId: data.id })).find(
            (item) => item.id === data.id,
          ),
        },
        202,
      );
    }
    if (data.action === "curate-playlist" || data.action === "retry-curation") {
      const studio = createIntelligentContentRepository(distributionPool(), {
        authorize: createStudioRoleAuthority(process.env),
      });
      if (data.action === "curate-playlist") {
        await studio.configurePlaylist(auth.context, data.id, data);
        const item = (await repo.list(auth.context, { rootId: data.id })).find(
          (entry) => entry.id === data.id,
        );
        if (item?.serviceIssue?.code !== "ONLINE_PROVIDER_VERIFICATION_REQUIRED")
          await repo.retryPlaylist(auth.context, data.id);
      } else await studio.retryPlaylistItem(auth.context, data.id, data.childId);
      return json(
        {
          item: (await repo.list(auth.context, { rootId: data.id })).find(
            (item) => item.id === data.id,
          ),
        },
        202,
      );
    }
    const item =
      data.action === "retry"
        ? await repository().retry(auth.context, data.id)
        : await repository().enqueue(auth.context, data);
    return json({ item }, 202);
  } catch (error) {
    if (error instanceof Error && error.message in ONLINE_IMPORT_ERRORS)
      return json(
        { error: error.message, message: ONLINE_IMPORT_ERRORS[error.message] },
        error.message === "ONLINE_IMPORT_BUSY" ? 429 : 400,
      );
    return safeProblem(error);
  }
}
