import { BridgeCommandError } from "../controller-leases.js";

type MaintenanceHost = {
  enterMaintenance(): void;
  beginUpgrade(): void;
  leaveMaintenance(): void;
};

export function createMaintenanceService(options: {
  host: MaintenanceHost;
  blockers?: () => readonly string[];
  cancel(): Promise<void>;
  drain(): Promise<void>;
  migrate(): Promise<void>;
  health(): Promise<boolean>;
  restart(): Promise<void>;
  commit(): Promise<void>;
  rollback?(): Promise<void>;
}) {
  return {
    async run(): Promise<{ status: "committed" | "rolled-back"; steps: string[] }> {
      const blockers = options.blockers?.() ?? [];
      if (blockers.length > 0) throw new BridgeCommandError("MAINTENANCE_BLOCKED");
      const steps: string[] = [];
      options.host.enterMaintenance(); steps.push("enter");
      try {
        await options.cancel(); steps.push("cancel");
        await options.drain(); steps.push("drain");
        options.host.beginUpgrade(); steps.push("upgrade");
        await options.migrate(); steps.push("migrate");
        if (!await options.health()) throw new BridgeCommandError("MAINTENANCE_HEALTH_FAILED");
        steps.push("health");
        await options.restart(); steps.push("restart");
        await options.commit(); steps.push("commit");
        options.host.leaveMaintenance(); steps.push("leave");
        return { status: "committed", steps };
      } catch (error) {
        await options.rollback?.();
        options.host.leaveMaintenance();
        throw error;
      }
    },
  };
}
