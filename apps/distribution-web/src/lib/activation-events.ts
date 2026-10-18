import { randomUUID } from "node:crypto";
import type { PersistedActivation } from "@satsang/distribution-db";
import { createSocialEventOutbox } from "@satsang/distribution-links/outbox";
/** The existing activation revision is authoritative. This delivers its anonymous operational
 * receipt to the same collector as the resolver; a spool fault never undoes human review. */
export async function enqueueDestinationValidation(activation: PersistedActivation): Promise<void> {
  if (!activation.reviewPackage?.destinationTest) return;
  const root = process.env.DISTRIBUTION_LINKS_EVENT_ROOT;
  const coreOrigin = process.env.STUDIO_DESTINATION_ORIGIN;
  const key = process.env.DISTRIBUTION_DESTINATION_KEY;
  if (!root || !coreOrigin || !key) {
    console.error("Activation destination audit saved; anonymous receipt spool is not configured.");
    return;
  }
  try {
    await createSocialEventOutbox({ root, coreOrigin, key }).enqueue({
      version: 1,
      isTest: true,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      name: "activation_destination_validated",
      activationId: activation.id,
      campaignId: activation.campaignId,
      contentId: activation.masterId,
      derivativeId: activation.derivativeId,
      ctaId: activation.ctaId,
      channel: activation.reviewPackage.channel,
      canonicalId: activation.reviewPackage.destinationTest.destination.canonicalId,
      fallbackReason: null,
    });
  } catch {
    console.error("Activation destination audit saved; anonymous receipt spool failed.");
  }
}
