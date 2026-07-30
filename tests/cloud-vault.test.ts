import { describe, expect, test } from "bun:test";
import { decryptVault, encryptVault, packVaultFiles, unpackVaultFiles } from "../src/cloud/vault";

describe("cloud vault", () => {
  test("round-trips encrypted payload", () => {
    const packed = packVaultFiles({
      "auth.json": '{"xai":{"accounts":[]}}\n',
      "codex-accounts.json": '{"accounts":[]}\n',
    });
    const blob = encryptVault(packed, "test-passphrase-ok");
    expect(blob.subarray(0, 5).toString("utf8")).toBe("OCXV1");
    const plain = decryptVault(blob, "test-passphrase-ok");
    const payload = unpackVaultFiles(plain);
    expect(payload.version).toBe(1);
    expect(payload.files["auth.json"]).toContain("xai");
  });

  test("rejects short passphrase", () => {
    expect(() => encryptVault("{}", "short")).toThrow(/at least 8/);
  });

  test("rejects wrong passphrase", () => {
    const blob = encryptVault(packVaultFiles({ "auth.json": "{}" }), "correct-passphrase");
    expect(() => decryptVault(blob, "wrong-passphrase!!")).toThrow(/wrong passphrase|decrypt failed/i);
  });
});
