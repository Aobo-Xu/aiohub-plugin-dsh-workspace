import { BridgeCommandError } from "../controller-leases.js";
import type { OperationAvailability } from "../../../runtime-facade/src/types.js";

type PackageInput = { packageId: string; sessionId: string; generation: string; confirmed: boolean; payload?: unknown };
type DynamicPort = {
  operationAvailability(id: string): OperationAvailability;
  define?(input: PackageInput): Promise<unknown>;
  run?(input: PackageInput): Promise<unknown>;
  update?(input: PackageInput): Promise<unknown>;
  stop?(input: PackageInput): Promise<unknown>;
  undefine?(input: PackageInput): Promise<unknown>;
  inventory?(input: { sessionId: string; generation: string }): Promise<unknown>;
  diagnostics?(input: { sessionId: string; generation: string }): Promise<unknown>;
};

export function createDynamicPackageService(options: { port: DynamicPort }) {
  const { port } = options;
  const call = async (operation: "define" | "run" | "update" | "stop" | "undefine", input: PackageInput) => {
    if (!input.confirmed) throw new BridgeCommandError("DYNAMIC_CONFIRMATION_REQUIRED");
    const id = `dynamic.host.${operation}`;
    if (!port.operationAvailability(id).available || !port[operation]) {
      throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", id);
    }
    return port[operation]!(input);
  };

  return {
    define: (input: PackageInput) => call("define", input),
    run: (input: PackageInput) => call("run", input),
    update: (input: PackageInput) => call("update", input),
    stop: (input: PackageInput) => call("stop", input),
    undefine: (input: PackageInput) => call("undefine", input),
    async inventory(input: { sessionId: string; generation: string }) {
      return read(port, "dynamic.host.inventory", "inventory", input);
    },
    async diagnostics(input: { sessionId: string; generation: string }) {
      return read(port, "dynamic.host.diagnostics", "diagnostics", input);
    },
    async browserInventory() {
      throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", "dynamic.browser.inventory");
    },
  };
}

async function read(port: DynamicPort, id: string, method: "inventory" | "diagnostics", input: { sessionId: string; generation: string }) {
  if (!port.operationAvailability(id).available || !port[method]) {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", id);
  }
  return port[method]!(input);
}
