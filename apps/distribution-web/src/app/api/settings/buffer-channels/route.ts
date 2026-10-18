import { z } from "zod";
import { findBufferYoutubeChannels } from "../../../../lib/buffer-channels";
import { json, readBoundedBody } from "../../../../lib/http";
import { access } from "../../../../lib/runtime";

const requestSchema = z
  .object({
    accessToken: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine((v) => !/[\r\n]/.test(v)),
  })
  .strict();
export async function POST(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  try {
    const command = requestSchema.safeParse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 16384))),
    );
    if (!command.success) return json({ error: "BUFFER_TOKEN_REQUIRED" }, 400);
    return json({ channels: await findBufferYoutubeChannels(command.data.accessToken) });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return json(
      {
        error: code === "BUFFER_AUTH_REQUIRED" ? code : "BUFFER_DISCOVERY_UNAVAILABLE",
      },
      400,
    );
  }
}
