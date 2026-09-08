import { BridgeCommandError } from "../controller-leases.js";
import type { MigrationInput, MigrationResult } from "../adapters/types.js";

/**
 * Opaque backup handle supplied by the managed-home implementation.  The
 * coordinator deliberately cannot inspect its contents: DSH owns session
 * schema and the workspace/Git tree is outside this boundary.
 */
export type ManagedBackupStore<TBackup> = {
  create(): Promise<TBackup>;
  restore(backup: TBackup): Promise<void>;
  discard(backup: TBackup): Promise<void>;
};

export type SessionMigrationAdapter = {
  migrate(input: MigrationInput): Promise<MigrationResult>;
};

/**
 * Coordinates an official Adapter migration with an opaque managed-data
 * backup.  No JSONL parsing, release-version branching, or workspace access
 * is possible from this module; all schema work remains in DSH's public API.
 */
export function createSessionMigrationCoordinator<TBackup>(options: {
  adapter: SessionMigrationAdapter;
  backup: ManagedBackupStore<TBackup>;
}) {
  return {
    async run(input: MigrationInput): Promise<MigrationResult> {
      const backup = await options.backup.create();
      let result: MigrationResult;
      try {
        result = await options.adapter.migrate(input);
      } catch (error) {
        try {
          await options.backup.restore(backup);
        } catch (restoreError) {
          const recovery = new BridgeCommandError("SESSION_MIGRATION_RECOVERY_FAILED");
          recovery.cause = restoreError;
          throw recovery;
        }
        throw error;
      }

      if (result.status === "not-migrated") {
        try {
          await options.backup.restore(backup);
        } catch (restoreError) {
          const recovery = new BridgeCommandError("SESSION_MIGRATION_RECOVERY_FAILED");
          recovery.cause = restoreError;
          throw recovery;
        }
        return result;
      }

      await options.backup.discard(backup);
      return result;
    },
  };
}
