import { BridgeCommandError } from "../controller-leases.js";
import type { OperationAvailability } from "../../../runtime-facade/src/types.js";

export type DiffArtifact = {
  workspaceId: string;
  path: string;
  base: string;
  revision: string;
  content: string;
  provenance: { source: "dsh"; snapshotId: string };
};

export type DiffReviewInput = Omit<DiffArtifact, "provenance"> & {
  snapshotId: string;
};

export function createDiffArtifactService(options: {
  operationAvailability(id: string): OperationAvailability;
  apply?(diff: DiffArtifact): Promise<unknown>;
}) {
  return {
    async review(input: DiffReviewInput): Promise<DiffArtifact> {
      require(options, "artifact.diff.review");
      const { snapshotId, ...diff } = input;
      return { ...diff, provenance: { source: "dsh", snapshotId } };
    },
    async apply(diff: DiffArtifact): Promise<unknown> {
      require(options, "artifact.diff.apply");
      if (!options.apply) throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", "artifact.diff.apply");
      return options.apply(diff);
    },
  };
}

function require(options: { operationAvailability(id: string): OperationAvailability }, id: string): void {
  if (!options.operationAvailability(id).available) {
    throw new BridgeCommandError("CAPABILITY_UNAVAILABLE", id);
  }
}
