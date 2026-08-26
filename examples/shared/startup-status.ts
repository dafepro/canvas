import type { RuntimeStartupSnapshot } from "@canvas-physics/client/runtime";

export interface StartupStatusOptions {
  readonly assetName?: string;
  readonly readyMessage?: string;
}

/** Example-owned wording for the library's semantic startup phases. */
export const formatStartupStatus = (
  snapshot: Readonly<RuntimeStartupSnapshot>,
  options: Readonly<StartupStatusOptions> = {},
): string => {
  switch (snapshot.phase) {
    case "assets": {
      const assets = snapshot.assets;
      return assets
        ? `Loading ${options.assetName ?? "assets"}… ${assets.settled}/${assets.total}`
        : `Loading ${options.assetName ?? "assets"}…`;
    }
    case "credentials":
      return "Requesting room access…";
    case "connecting":
      return "Opening realtime connection…";
    case "joining":
      return "Joining room…";
    case "simulation":
      return "Starting physics simulation…";
    case "canonical":
      return "Syncing authoritative room state…";
    case "presenting":
      return "Preparing first frame…";
    case "ready":
      return options.readyMessage ?? "Ready";
    case "failed":
      return `Startup failed · ${snapshot.error?.message ?? "unknown error"}`;
    case "cancelled":
      return "Startup cancelled";
  }
};
