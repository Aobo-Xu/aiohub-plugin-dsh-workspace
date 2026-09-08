import { BridgeCommandError } from "../controller-leases.js";
import type { OperationAvailability } from "../../../runtime-facade/src/types.js";

type PresetPort = {
  operationAvailability(id: string): OperationAvailability;
  catalog?(): Promise<unknown>;
  select?(input: { presetId: string; sessionId: string }): Promise<unknown>;
};

export function createPresetService(options: { port: PresetPort }) {
  return {
    async catalog(): Promise<unknown> {
      require(options.port, "preset.catalog", "catalog");
      return options.port.catalog!();
    },
    async select(presetId: string, sessionId: string): Promise<unknown> {
      require(options.port, "preset.select", "select");
      return options.port.select!({ presetId, sessionId });
    },
  };
}

function require(port: PresetPort, id: string, method: keyof PresetPort): void {
  if (!port.operationAvailability(id).available || typeof port[method] !== "function") {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", id);
  }
}
