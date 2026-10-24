import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  ComputerRecoveryAction,
  ComputerRecoveryState,
} from "@satsang/distribution-contracts";
import { type DistributionContext, createStudioRoleAuthority } from "@satsang/distribution-db";
import { COMPUTER_RECOVERY_ERRORS, computerRecoveryEnabled } from "@satsang/distribution-domain";
import { recoverPlaylistOnComputer } from "./computer-recovery-runner.js";
import { checkOnlineImportRuntime } from "./online-import-runtime.js";

export function createComputerRecoveryManager(input: {
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  authorize?: ReturnType<typeof createStudioRoleAuthority>;
  run?: typeof recoverPlaylistOnComputer;
  preflight?: typeof checkOnlineImportRuntime;
}) {
  const authorize = input.authorize ?? createStudioRoleAuthority(input.env);
  let job:
    | {
        userId: string;
        bundle: string;
        state: ComputerRecoveryState;
        controller: AbortController;
        done: Promise<void>;
      }
    | undefined;
  const idle = (): ComputerRecoveryState => ({ status: "IDLE", recordings: 0, completed: 0 });
  const active = () => job?.state.status === "RUNNING" || job?.state.status === "STOPPING";
  async function allowed(context: DistributionContext) {
    if (!computerRecoveryEnabled(input.env)) throw Error("RECOVERY_LOCAL_REQUIRED");
    if (
      !context.isTest ||
      !(await authorize({ userId: context.userId, isTest: true, capability: "content.create" }))
    )
      throw Error("RECOVERY_FORBIDDEN");
  }
  return {
    active,
    async handle(
      context: DistributionContext,
      bundle: string,
      command: ComputerRecoveryAction,
    ): Promise<ComputerRecoveryState> {
      await allowed(context);
      if (job && (job.userId !== context.userId || job.bundle !== bundle)) {
        if (active()) throw Error("RECOVERY_BUSY");
        if (command.action !== "start") return idle();
      }
      if (command.action === "status") return job ? { ...job.state } : idle();
      if (command.action === "stop") {
        if (job && active()) {
          job.state.status = "STOPPING";
          job.controller.abort();
        }
        return job ? { ...job.state } : idle();
      }
      if (active()) return { ...(job?.state ?? idle()) };
      const directory = input.env.STUDIO_COMPUTER_RECOVERY_DIRECTORY;
      if (!directory || !isAbsolute(directory)) throw Error("RECOVERY_NOT_CONFIGURED");
      const controller = new AbortController();
      const current = {
        userId: context.userId,
        bundle,
        state: { ...idle(), status: "RUNNING", phase: "connecting" } as ComputerRecoveryState,
        controller,
        done: Promise.resolve(),
      };
      job = current;
      const signal = AbortSignal.any([input.signal, controller.signal]);
      const checkAuthority = () => allowed(context);
      let checking = false;
      let authorityLost = false;
      const heartbeat = setInterval(() => {
        if (checking) return;
        checking = true;
        void checkAuthority()
          .catch(() => {
            authorityLost = true;
            controller.abort();
          })
          .finally(() => {
            checking = false;
          });
      }, 30000);
      heartbeat.unref();
      current.done = (async () => {
        try {
          await (input.preflight ?? checkOnlineImportRuntime)(input.env.STUDIO_YTDLP_PATH);
          signal.throwIfAborted();
          await (input.run ?? recoverPlaylistOnComputer)({
            bundle,
            username: command.username,
            password: command.password,
            directory: join(directory, createHash("sha256").update(context.userId).digest("hex")),
            binary: input.env.STUDIO_YTDLP_PATH,
            signal,
            authorize: checkAuthority,
            progress: (state) => {
              current.state = { ...current.state, ...state };
            },
          });
          signal.throwIfAborted();
          current.state.status = "COMPLETE";
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          current.state.status = signal.aborted && !authorityLost ? "PAUSED" : "FAILED";
          current.state.error = authorityLost
            ? "RECOVERY_FORBIDDEN"
            : signal.aborted
              ? undefined
              : Object.hasOwn(COMPUTER_RECOVERY_ERRORS, code)
                ? code
                : ["ENOSPC", "EACCES", "EROFS"].includes(
                      (error as NodeJS.ErrnoException)?.code ?? "",
                    )
                  ? "RECOVERY_STORAGE_UNAVAILABLE"
                  : "RECOVERY_INTERRUPTED";
        } finally {
          command.password = "";
          clearInterval(heartbeat);
        }
      })();
      return { ...current.state };
    },
    async close() {
      job?.controller.abort();
      await job?.done;
    },
  };
}
