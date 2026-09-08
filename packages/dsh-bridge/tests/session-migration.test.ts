import { describe, expect, it, vi } from "vitest";
import { createSessionMigrationCoordinator } from "../src/maintenance/session-migration.js";

describe("managed session migration", () => {
  it("backs up before delegating to the official adapter and discards on success", async () => {
    const order: string[] = [];
    const adapter = {
      migrate: vi.fn(async () => {
        order.push("adapter.migrate");
        return { status: "migrated" as const, sessionId: "s-1", schemaVersion: 2 };
      }),
    };
    const backup = {
      create: vi.fn(async () => {
        order.push("backup.create");
        return { id: "backup-1" };
      }),
      restore: vi.fn(async () => order.push("backup.restore")),
      discard: vi.fn(async () => order.push("backup.discard")),
    };

    const result = await createSessionMigrationCoordinator({ adapter, backup }).run({
      sessionId: "s-1",
      payload: { schema: "official" },
    });

    expect(result.status).toBe("migrated");
    expect(order).toEqual(["backup.create", "adapter.migrate", "backup.discard"]);
    expect(backup.restore).not.toHaveBeenCalled();
  });

  it("restores the managed backup when the official migration fails", async () => {
    const order: string[] = [];
    const adapter = {
      migrate: vi.fn(async () => {
        order.push("adapter.migrate");
        throw new Error("migration failed");
      }),
    };
    const backup = {
      create: vi.fn(async () => {
        order.push("backup.create");
        return { id: "backup-1" };
      }),
      restore: vi.fn(async () => order.push("backup.restore")),
      discard: vi.fn(async () => order.push("backup.discard")),
    };

    await expect(
      createSessionMigrationCoordinator({ adapter, backup }).run({
        sessionId: "s-1",
        payload: { schema: "official" },
      }),
    ).rejects.toThrow("migration failed");
    expect(order).toEqual(["backup.create", "adapter.migrate", "backup.restore"]);
    expect(backup.discard).not.toHaveBeenCalled();
  });

  it("restores on an explicit not-migrated result without parsing session files", async () => {
    const backup = {
      create: vi.fn(async () => ({ id: "backup-1" })),
      restore: vi.fn(async () => undefined),
      discard: vi.fn(async () => undefined),
    };
    const adapter = {
      migrate: vi.fn(async () => ({
        status: "not-migrated" as const,
        reason: { code: "CAPABILITY_UNAVAILABLE" as const },
      })),
    };

    const result = await createSessionMigrationCoordinator({ adapter, backup }).run({
      sessionId: "s-1",
      payload: { schema: "official" },
    });

    expect(result.status).toBe("not-migrated");
    expect(backup.restore).toHaveBeenCalledWith({ id: "backup-1" });
  });

  it("surfaces a stable recovery error when backup restore fails", async () => {
    const adapter = {
      migrate: vi.fn(async () => {
        throw new Error("migration failed");
      }),
    };
    const backup = {
      create: vi.fn(async () => ({ id: "backup-1" })),
      restore: vi.fn(async () => {
        throw new Error("restore failed");
      }),
      discard: vi.fn(async () => undefined),
    };

    await expect(
      createSessionMigrationCoordinator({ adapter, backup }).run({
        sessionId: "s-1",
        payload: { schema: "official" },
      }),
    ).rejects.toThrow("SESSION_MIGRATION_RECOVERY_FAILED");
  });
});
