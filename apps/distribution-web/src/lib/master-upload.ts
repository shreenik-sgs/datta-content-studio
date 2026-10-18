import { MAX_MASTER_BYTES } from "@satsang/distribution-domain";

export class MasterUploadSizeError extends Error {
  constructor(bytes: number) {
    super(`Choose a file no larger than ${bytes / 1024 / 1024} MB.`);
  }
}
export class MasterUploadBusyError extends Error {
  constructor() {
    super("Another master upload is in progress. Please wait for it to finish, then try again.");
  }
}
export class MasterUploadDuplicateError extends Error {
  constructor() {
    super(
      "This exact file is already in the Master Library. Open its existing workspace under Continue Existing Curation or Curation Complete Library. If archived, check archived masters. No duplicate was saved.",
    );
  }
}
/** Refuse oversized files before the proxy reads or truncates their multipart body. */
export async function uploadMaster(
  url: string,
  form: FormData,
  maximum = MAX_MASTER_BYTES,
): Promise<Response> {
  const file = form.get("file");
  if (file instanceof Blob && file.size > maximum) throw new MasterUploadSizeError(maximum);
  const response = await fetch(url, { method: "POST", body: form });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    if (response.status === 413)
      throw new MasterUploadSizeError(problem?.maxMasterBytes ?? maximum);
    if (problem?.error === "UPLOAD_BUSY") throw new MasterUploadBusyError();
    if (problem?.error === "DUPLICATE_MASTER") throw new MasterUploadDuplicateError();
    throw new Error(typeof problem?.error === "string" ? problem.error : "UNAVAILABLE");
  }
  return response;
}
