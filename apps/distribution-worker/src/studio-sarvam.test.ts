import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSarvamStudioTranscription, transcribeSarvamStudioAudio } from "./studio-sarvam";

const API = "https://api.sarvam.ai/speech-to-text/job/v1";
const JOB = "job_test-123";
const UPLOAD = "https://sarvamtest.blob.core.windows.net/job/source.mp3?sig=synthetic-upload";
const DOWNLOAD = "https://sarvamtest.blob.core.windows.net/job/0.json?sig=synthetic-download";
const job = (state = "Accepted") => ({
  job_id: JOB,
  job_state: state,
  storage_container_type: "Azure_V1",
});
const complete = () => ({
  ...job("Completed"),
  total_files: 1,
  successful_files_count: 1,
  failed_files_count: 0,
  job_details: [
    {
      inputs: [{ file_name: "source.mp3", file_id: "input-0" }],
      outputs: [{ file_name: "0.json", file_id: "output-0" }],
      state: "Success",
    },
  ],
});
const raw = () => ({
  language_code: "te-IN",
  transcript: "జయ గురు దత్త. శ్రీ గురు దత్త.",
  timestamps: {
    chunks: ["జయ గురు దత్త.", "శ్రీ గురు దత్త."],
    start_time_seconds: [0.1, 2],
    end_time_seconds: [1.5, 4],
  },
});
function replies() {
  return [
    Response.json(job(), { status: 202 }),
    Response.json({ ...job(), upload_urls: { "source.mp3": { file_url: UPLOAD } } }),
    new Response(null, { status: 201 }),
    Response.json(job("Running")),
    Response.json(complete()),
    Response.json({ ...job("Completed"), download_urls: { "0.json": { file_url: DOWNLOAD } } }),
    Response.json(raw()),
  ];
}
function fixture(responses = replies()) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  return fetcher;
}
const input = () => ({
  bytes: new Uint8Array([1, 2, 3]),
  language: "te",
  durationMs: 20 * 60 * 1000,
  apiKey: "synthetic-api-key",
  fetcher: fixture(),
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sarvam Studio batch adapter — mocked provider only", () => {
  it("transcribes a whole long recording in native script with v4 and real phrase timestamps", async () => {
    const value = input();
    const result = await transcribeSarvamStudioAudio({
      ...value,
      keyterms: ["గణపతి సచ్చిదానంద", "Datta Peetham"],
    });
    expect(result).toEqual({
      language: "te",
      durationMs: 1200000,
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
      recognition: { provider: "sarvam", model: "saaras:v4" },
      segments: [
        { id: "segment-1", startMs: 100, endMs: 1500, text: "జయ గురు దత్త." },
        { id: "segment-2", startMs: 2000, endMs: 4000, text: "శ్రీ గురు దత్త." },
      ],
    });
    const calls = value.fetcher.mock.calls;
    expect(calls.map(([url]) => url)).toEqual([
      API,
      `${API}/upload-files`,
      UPLOAD,
      `${API}/${JOB}/start`,
      `${API}/${JOB}/status`,
      `${API}/download-files`,
      DOWNLOAD,
    ]);
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({
      job_parameters: {
        model: "saaras:v4",
        mode: "transcribe",
        language_code: "te-IN",
        with_timestamps: true,
        with_diarization: false,
        input_audio_codec: "mp3",
        keyterms: ["గణపతి సచ్చిదానంద", "Datta Peetham"],
      },
    });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({ job_id: JOB, files: ["source.mp3"] });
    expect(JSON.parse(String(calls[5]?.[1]?.body))).toEqual({ job_id: JOB, files: ["0.json"] });
    for (const [url, request] of calls) {
      expect(request?.redirect).toBe("error");
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(request?.headers);
      expect(headers.get("api-subscription-key")).toBe(
        String(url).startsWith(API) ? value.apiKey : null,
      );
      expect(String(url)).not.toContain(value.apiKey);
    }
    expect(calls[2]?.[1]?.method).toBe("PUT");
    expect(calls[2]?.[1]?.body).toEqual(value.bytes);
    expect(new Headers(calls[2]?.[1]?.headers).get("x-ms-blob-type")).toBe("BlockBlob");
  });

  it("polls pending/running jobs at five-second intervals", async () => {
    vi.useFakeTimers();
    const responses = replies();
    responses.splice(4, 0, Response.json(job("Pending")), Response.json(job("Running")));
    const fetcher = fixture(responses);
    const result = transcribeSarvamStudioAudio({ ...input(), fetcher });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetcher).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await result).language).toBe("te");
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("accepts the live v4 words schema as complete phrases with original timing", async () => {
    const responses = replies();
    responses[6] = Response.json({
      language_code: "te-IN",
      transcript:
        "దోమ్యుడు, వ్యాసుడు, నారద మహర్షిని, అసిత మహర్షిని, దేవల మహర్షిని ముందు పెట్టుకొని ధర్మరాజుకు అభిషేకం చేశారు.",
      timestamps: {
        words: [
          "దోమ్యుడు, వ్యాసుడు, నారద మహర్షిని, అసిత మహర్షిని, దేవల మహర్షిని ముందు పెట్టుకొని ధర్మరాజుకు అభిషేకం చేశారు.",
        ],
        start_time_seconds: [30.53],
        end_time_seconds: [42.15],
      },
    });
    const result = await transcribeSarvamStudioAudio({ ...input(), fetcher: fixture(responses) });
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toMatchObject({
      id: "segment-1",
      startMs: 30530,
      endMs: 42150,
    });
    expect(result.segments[0]?.text).toContain("ధర్మరాజుకు అభిషేకం చేశారు.");
  });

  it("accepts identical chunks and words aliases without duplicating segments", () => {
    const value = raw();
    const result = normalizeSarvamStudioTranscription(
      {
        ...value,
        timestamps: { ...value.timestamps, words: [...value.timestamps.chunks] },
      },
      "te",
      4000,
    );
    expect(result.segments).toHaveLength(2);
  });

  it("bounds Sarvam's centisecond EOF rounding without losing the final spoken phrase", () => {
    const phrase = "జయ గురు దత్త. శ్రీ గురు దత్త.";
    const result = normalizeSarvamStudioTranscription(
      {
        language_code: "te-IN",
        transcript: phrase,
        timestamps: { words: [phrase], start_time_seconds: [3000], end_time_seconds: [3019.34] },
      },
      "te",
      3019337,
    );
    expect(result.segments).toEqual([
      { id: "segment-1", text: phrase, startMs: 3000000, endMs: 3019337 },
    ]);
    expect(result.durationMs).toBe(3019337);
  });

  it.each([
    { end: 3019.35, duration: 3019337 }, // A real overrun exceeds the half-tick allowance.
    { end: 3019.338, duration: 3019337 }, // Non-quantized precision cannot use this exception.
    { end: 3019.34, duration: 3019334 },
    { end: Number.POSITIVE_INFINITY, duration: 3019337 },
  ])(
    "retains strict timing checks outside Sarvam's half-tick rounding: %j",
    ({ end, duration }) => {
      expect(() =>
        normalizeSarvamStudioTranscription(
          {
            language_code: "te-IN",
            transcript: "జయ గురు దత్త.",
            timestamps: {
              words: ["జయ గురు దత్త."],
              start_time_seconds: [3000],
              end_time_seconds: [end],
            },
          },
          "te",
          duration,
        ),
      ).toThrow("STUDIO_TRANSCRIPT_INVALID");
    },
  );

  it.each([
    { words: ["different", "text"] },
    { words: ["జయ గురు దత్త."] },
    { words: null },
    { words: ["జయ గురు దత్త.", "శ్రీ గురు దత్త."], chunks: null },
  ])("refuses ambiguous or malformed words/chunks aliases", (override) => {
    const value = raw();
    expect(() =>
      normalizeSarvamStudioTranscription(
        {
          ...value,
          timestamps: { ...value.timestamps, ...override },
        },
        "te",
        4000,
      ),
    ).toThrow("STUDIO_TRANSCRIPT_INVALID");
  });

  it.each(["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"])(
    "uses the requested native language %s",
    async (language) => {
      const responses = replies();
      responses[6] = Response.json({ ...raw(), language_code: `${language}-IN` });
      const fetcher = fixture(responses);
      expect((await transcribeSarvamStudioAudio({ ...input(), language, fetcher })).language).toBe(
        language,
      );
      expect(
        JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).job_parameters.language_code,
      ).toBe(`${language}-IN`);
    },
  );

  it.each([
    { apiKey: " " },
    { bytes: new Uint8Array() },
    { durationMs: 7200001 },
    { durationMs: 0 },
    { durationMs: 1.5 },
    { language: "unknown" },
    { model: "unrecognized-model" },
    { keyterms: [" "] },
    { keyterms: ["a".repeat(65)] },
    { keyterms: ["bad\nterm"] },
    { keyterms: Array.from({ length: 51 }, () => "term") },
    { model: "saaras:v3", keyterms: ["term"] },
  ])("rejects invalid inputs before a paid job exists: %j", async (override) => {
    const value = { ...input(), ...override };
    await expect(transcribeSarvamStudioAudio(value)).rejects.toThrow(/^STUDIO_/);
    expect(value.fetcher).not.toHaveBeenCalled();
  });

  it("rejects oversized audio before creating a paid job", async () => {
    const value = { ...input(), bytes: new Uint8Array(128 * 1024 * 1024 + 1) };
    await expect(transcribeSarvamStudioAudio(value)).rejects.toThrow(
      "STUDIO_TRANSCRIPTION_NOT_CONFIGURED_OR_TOO_LARGE",
    );
    expect(value.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://attacker.example/source.mp3",
    "http://sarvamtest.blob.core.windows.net/source.mp3",
    "https://sarvamtest.blob.core.windows.net.evil.example/source.mp3",
    "https://user:password@sarvamtest.blob.core.windows.net/source.mp3",
    "https://sarvamtest.blob.core.windows.net:8443/source.mp3",
    "https://127.0.0.1/source.mp3",
    "https://169.254.169.254/latest/meta-data/",
    "https://sarvamtest.blob.core.windows.net/source.mp3#fragment",
  ])("refuses unsafe upload destinations without sending media: %s", async (url) => {
    const responses = replies();
    responses[1] = Response.json({ ...job(), upload_urls: { "source.mp3": { file_url: url } } });
    const fetcher = fixture(responses);
    await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
      "STUDIO_PROVIDER_UNSAFE_STORAGE_URL",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects untrusted result URLs before fetching", async () => {
    const responses = replies();
    responses[5] = Response.json({
      ...job("Completed"),
      download_urls: { "0.json": { file_url: "https://private.example/secret" } },
    });
    const fetcher = fixture(responses);
    await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
      "STUDIO_PROVIDER_UNSAFE_STORAGE_URL",
    );
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("allows Google signed storage without leaking the Sarvam key", async () => {
    const responses = replies();
    responses[1] = Response.json({
      ...job(),
      storage_container_type: "Google",
      upload_urls: {
        "source.mp3": { file_url: "https://storage.googleapis.com/sarvam/source.mp3?sig=fake" },
      },
    });
    responses[5] = Response.json({
      ...job("Completed"),
      storage_container_type: "Google",
      download_urls: {
        "0.json": { file_url: "https://bucket.storage.googleapis.com/0.json?sig=fake" },
      },
    });
    const fetcher = fixture(responses);
    await transcribeSarvamStudioAudio({ ...input(), fetcher });
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("api-subscription-key")).toBeNull();
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("x-ms-blob-type")).toBeNull();
  });

  it.each([
    "sarvam-test-bucket.s3.amazonaws.com",
    "sarvam-test-bucket.s3.ap-south-1.amazonaws.com",
    "saas-prod-vistaar-bulk-upload.s3.amazonaws.com",
  ])(
    "resumes a created job through AWS %s without another paid job or Azure headers",
    async (hostname) => {
      const upload = `https://${hostname}/source.mp3?X-Amz-Signature=fake`;
      const download = `https://${hostname}/0.json?X-Amz-Signature=fake`;
      const responses = replies().slice(1);
      responses[0] = Response.json({
        ...job(),
        storage_container_type: "AWS",
        upload_urls: { "source.mp3": { file_url: upload } },
      });
      responses[4] = Response.json({
        ...job("Completed"),
        storage_container_type: "AWS",
        download_urls: { "0.json": { file_url: download } },
      });
      const fetcher = fixture(responses);
      const save = vi.fn();
      const result = await transcribeSarvamStudioAudio({
        ...input(),
        fetcher,
        recovery: { saved: { jobId: JOB, stage: "created" }, save },
      });
      expect(result.segments).toHaveLength(2);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        `${API}/upload-files`,
        upload,
        `${API}/${JOB}/start`,
        `${API}/${JOB}/status`,
        `${API}/download-files`,
        download,
      ]);
      for (const index of [1, 5]) {
        const options = fetcher.mock.calls[index]?.[1];
        expect(options?.redirect).toBe("error");
        expect(new Headers(options?.headers).get("api-subscription-key")).toBeNull();
        expect(new Headers(options?.headers).get("x-ms-blob-type")).toBeNull();
      }
      expect(save.mock.calls.map(([checkpoint]) => checkpoint.stage)).toEqual([
        "starting",
        "started",
      ]);
    },
  );

  it.each([
    ["AWS", "https://bucket.s3.amazonaws.com.evil.test/source.mp3"],
    ["AWS", "https://ec2.ap-south-1.amazonaws.com/source.mp3"],
    ["AWS", "https://lambda.ap-south-1.amazonaws.com/source.mp3"],
    ["AWS", "https://s3.amazonaws.com/bucket/source.mp3"],
    ["AWS", "https://distribution.cloudfront.net/source.mp3"],
    ["AWS", "https://bucket.s3-accelerate.amazonaws.com/source.mp3"],
    ["AWS", "https://bucket.s3.ap-south-1.amazonaws.com.evil.test/source.mp3"],
    ["AWS", "https://bucket.s3-website.ap-south-1.amazonaws.com/source.mp3"],
    ["AWS", "https://127.0.0.1/source.mp3"],
    ["AWS", "http://bucket.s3.amazonaws.com/source.mp3"],
    ["AWS", "https://user:secret@bucket.s3.amazonaws.com/source.mp3"],
    ["AWS", "https://bucket.s3.amazonaws.com:8443/source.mp3"],
    ["AWS", "https://bucket.s3.amazonaws.com/source.mp3#fragment"],
    ["Google", "https://bucket.s3.amazonaws.com/source.mp3"],
    ["AWS", "https://storage.googleapis.com/bucket/source.mp3"],
    ["Azure_V1", "https://bucket.s3.amazonaws.com/source.mp3"],
    ["AWS", "https://sarvamtest.blob.core.windows.net/job/source.mp3"],
  ])("refuses unsafe or mismatched %s storage: %s", async (storageType, url) => {
    for (const download of [false, true]) {
      const responses = replies();
      responses[download ? 5 : 1] = Response.json({
        ...job(download ? "Completed" : "Accepted"),
        storage_container_type: storageType,
        ...(download
          ? { download_urls: { "0.json": { file_url: url } } }
          : { upload_urls: { "source.mp3": { file_url: url } } }),
      });
      const fetcher = fixture(responses);
      await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
        "STUDIO_PROVIDER_UNSAFE_STORAGE_URL",
      );
      expect(fetcher).toHaveBeenCalledTimes(download ? 6 : 2);
    }
  });

  it.each([
    [429, "STUDIO_PROVIDER_RATE_LIMITED"],
    [401, "STUDIO_PROVIDER_AUTHENTICATION_FAILED"],
    [403, "STUDIO_PROVIDER_AUTHENTICATION_FAILED"],
    [500, "STUDIO_PROVIDER_UNAVAILABLE"],
  ])("sanitizes HTTP %i errors without automatic paid retries", async (status, code) => {
    const fetcher = fixture([
      new Response("private signed URL and key", { status: Number(status) }),
    ]);
    await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
      String(code),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("sanitizes transport errors", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("https://signed.example/?key=private"));
    await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
      "STUDIO_PROVIDER_UNAVAILABLE",
    );
  });

  it.each([
    [429, "STUDIO_PROVIDER_RATE_LIMITED", true],
    [500, "STUDIO_PROVIDER_UNAVAILABLE", false],
  ])(
    "distinguishes a rejected creation from an uncertain HTTP %i creation",
    async (status, code, resumable) => {
      const fetcher = fixture([new Response("private provider details", { status })]);
      const save = vi.fn();
      await expect(
        transcribeSarvamStudioAudio({ ...input(), fetcher, recovery: { saved: undefined, save } }),
      ).rejects.toMatchObject({ message: code, transcriptionResumable: resumable });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...job("Failed"), error_message: "secret provider error" },
    { ...complete(), job_id: "another-job" },
    { ...complete(), failed_files_count: 1 },
    { ...complete(), successful_files_count: 0 },
    {
      ...complete(),
      job_details: [
        {
          inputs: [{ file_name: "someone-elses.mp3" }],
          outputs: [{ file_name: "0.json" }],
          state: "Success",
        },
      ],
    },
    {
      ...complete(),
      job_details: [
        {
          inputs: [{ file_name: "source.mp3" }],
          outputs: [{ file_name: "../private.json" }],
          state: "Success",
        },
      ],
    },
  ])("refuses failed, mismatched or malformed completed jobs", async (status) => {
    const responses = replies();
    responses[4] = Response.json(status);
    const fetcher = fixture(responses);
    await expect(transcribeSarvamStudioAudio({ ...input(), fetcher })).rejects.toThrow(
      /^STUDIO_PROVIDER_/,
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("recognizes only a confirmed terminal context limit and sanitizes provider details", async () => {
    const status = {
      ...complete(),
      successful_files_count: 0,
      failed_files_count: 1,
      job_details: [
        {
          state: "API Error",
          inputs: [{ file_name: "source.mp3" }],
          error_message: `400:{"error":{"message":"Input length (4257) exceeds model's maximum context length (4096).","request_id":"private"}}`,
        },
      ],
    };
    const fetcher = fixture([Response.json(status)]);
    await expect(
      transcribeSarvamStudioAudio({
        ...input(),
        fetcher,
        recovery: { saved: { jobId: JOB, stage: "started" }, save: vi.fn() },
      }),
    ).rejects.toThrow("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows confirmed empty music sections without accepting an empty master or malformed timing", () => {
    const raw = {
      language_code: "te-IN",
      transcript: "",
      timestamps: { words: [], start_time_seconds: [], end_time_seconds: [] },
    };
    expect(normalizeSarvamStudioTranscription(raw, "te", 120000, true).segments).toEqual([]);
    expect(() => normalizeSarvamStudioTranscription(raw, "te", 120000)).toThrow(
      "STUDIO_TRANSCRIPT_INVALID",
    );
    expect(() =>
      normalizeSarvamStudioTranscription(
        { ...raw, timestamps: { ...raw.timestamps, words: ["lost speech"] } },
        "te",
        120000,
        true,
      ),
    ).toThrow("STUDIO_TRANSCRIPT_INVALID");
  });

  it("bounds provider result size using declared and streamed bytes", async () => {
    for (const response of [
      new Response("{}", { headers: { "content-length": String(16 * 1024 * 1024 + 1) } }),
      new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
    ]) {
      const responses = replies();
      responses[6] = response;
      await expect(
        transcribeSarvamStudioAudio({ ...input(), fetcher: fixture(responses) }),
      ).rejects.toThrow("STUDIO_PROVIDER_RESPONSE_LIMIT");
    }
  });

  it("stops before creating a job when already cancelled", async () => {
    const value = input();
    await expect(
      transcribeSarvamStudioAudio({ ...value, signal: AbortSignal.abort() }),
    ).rejects.toThrow("STUDIO_PROVIDER_ABORTED");
    expect(value.fetcher).not.toHaveBeenCalled();
  });

  it("cancels while waiting for a job and makes no further calls", async () => {
    vi.useFakeTimers();
    const responses = replies();
    responses[4] = Response.json(job("Running"));
    const controller = new AbortController();
    const fetcher = fixture(responses);
    const promise = transcribeSarvamStudioAudio({ ...input(), fetcher, signal: controller.signal });
    const check = expect(promise).rejects.toThrow("STUDIO_PROVIDER_ABORTED");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await check;
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("carries the saved-job evidence through a deployment cancellation", async () => {
    vi.useFakeTimers();
    const responses = replies();
    responses[4] = Response.json(job("Running"));
    const controller = new AbortController();
    const fetcher = fixture(responses);
    const save = vi.fn().mockResolvedValue(undefined);
    const promise = transcribeSarvamStudioAudio({
      ...input(),
      fetcher,
      signal: controller.signal,
      recovery: { saved: undefined, save },
    });
    const check = expect(promise).rejects.toMatchObject({
      message: "STUDIO_PROVIDER_ABORTED",
      transcriptionResumable: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await check;
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ stage: "started" }));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it.each([
    { language_code: "en-IN" },
    { transcript: "" },
    { timestamps: { chunks: ["x"], start_time_seconds: [], end_time_seconds: [1] } },
    { timestamps: { chunks: ["x"], start_time_seconds: [0], end_time_seconds: [9] } },
    { timestamps: { chunks: ["x", "y"], start_time_seconds: [0, 0.5], end_time_seconds: [1, 2] } },
    { timestamps: { chunks: ["x"], start_time_seconds: ["0"], end_time_seconds: [1] } },
    { timestamps: { chunks: ["x"], start_time_seconds: [Number.NaN], end_time_seconds: [1] } },
  ])("refuses missing/invalid timing or silently translated transcripts", (override) => {
    expect(() => normalizeSarvamStudioTranscription({ ...raw(), ...override }, "te", 4000)).toThrow(
      /^STUDIO_TRANSCRIPT_/,
    );
  });
});

it("resumes the same saved Sarvam job after a polling failure without uploading or starting again", async () => {
  const saved = { jobId: JOB, stage: "started" as const };
  const fetcher = fixture([Response.json(complete()), ...replies().slice(5)]);
  const result = await transcribeSarvamStudioAudio({
    ...input(),
    fetcher,
    recovery: { saved, save: vi.fn() },
  });
  expect(result.recognition?.provider).toBe("sarvam");
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${API}/${JOB}/status`,
    `${API}/download-files`,
    DOWNLOAD,
  ]);
});
it("never recreates or restarts a job whose start is uncertain", async () => {
  const fetcher = fixture([Response.json(job("Accepted"))]);
  await expect(
    transcribeSarvamStudioAudio({
      ...input(),
      fetcher,
      recovery: { saved: { jobId: JOB, stage: "starting" }, save: vi.fn() },
    }),
  ).rejects.toThrow("STUDIO_TRANSCRIPTION_START_UNCERTAIN");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe("GET");
});

it.each([429, 401, 400])(
  "keeps the same job retryable when its start is explicitly rejected (%s)",
  async (status) => {
    const responses = replies().slice(0, 3);
    responses.push(new Response(null, { status }));
    const save = vi.fn().mockResolvedValue(undefined);
    const fetcher = fixture(responses);
    await expect(
      transcribeSarvamStudioAudio({
        ...input(),
        fetcher,
        recovery: { saved: undefined, save },
      }),
    ).rejects.toThrow(/^STUDIO_PROVIDER_/);
    expect(save.mock.calls.map(([value]) => value)).toEqual([
      { jobId: JOB, stage: "created" },
      { jobId: JOB, stage: "starting" },
      { jobId: JOB, stage: "created" },
    ]);
    expect(fetcher.mock.calls.filter(([url]) => url === `${API}/${JOB}/start`)).toHaveLength(1);
  },
);

it("does not reset an ambiguous server failure to a retryable start", async () => {
  const responses = replies().slice(0, 3);
  responses.push(new Response(null, { status: 503 }));
  const save = vi.fn().mockResolvedValue(undefined);
  await expect(
    transcribeSarvamStudioAudio({
      ...input(),
      fetcher: fixture(responses),
      recovery: { saved: undefined, save },
    }),
  ).rejects.toThrow("STUDIO_PROVIDER_UNAVAILABLE");
  expect(save).toHaveBeenLastCalledWith({ jobId: JOB, stage: "starting" });
});

it("resumes a created job after upload failure without creating another transcription job", async () => {
  const fetcher = fixture(replies().slice(1));
  const save = vi.fn();
  await transcribeSarvamStudioAudio({
    ...input(),
    fetcher,
    recovery: { saved: { jobId: JOB, stage: "created" }, save },
  });
  expect(fetcher.mock.calls[0]?.[0]).toBe(`${API}/upload-files`);
  expect(fetcher.mock.calls.some(([url]) => url === API)).toBe(false);
  expect(save).toHaveBeenLastCalledWith({ jobId: JOB, stage: "started" });
});
it("reports an unsent DNS failure as recoverable while keeping ambiguous network failures unsafe", async () => {
  for (const [code, safe] of [
    ["EAI_AGAIN", true],
    ["ECONNRESET", false],
  ] as const) {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("private signed URL", { cause: { code } }));
    const error = await transcribeSarvamStudioAudio({ ...input(), fetcher }).catch((e) => e);
    expect(error.message).toBe("STUDIO_PROVIDER_UNAVAILABLE");
    expect(error.requestNotSent).toBe(safe);
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
});

it("marks upload setup failures resumable only after the same job was durably saved", async () => {
  const fetcher = fixture([replies()[0] as Response, new Response(null, { status: 503 })]);
  const error = await transcribeSarvamStudioAudio({
    ...input(),
    fetcher,
    recovery: { saved: undefined, save: vi.fn() },
  }).catch((e) => e);
  expect(error.transcriptionResumable).toBe(true);
  expect(error.requestNotSent).toBe(false);
  const unsaved = await transcribeSarvamStudioAudio({
    ...input(),
    fetcher: fixture([new Response(null, { status: 503 })]),
  }).catch((e) => e);
  expect(unsaved.transcriptionResumable).toBe(false);
});
