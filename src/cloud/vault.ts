/**
 * Passphrase-encrypted vault for sensitive OpenCodex state (auth / account pools).
 * Format: base64(JSON header) + "." + base64(iv||ciphertext||tag) is avoided —
 * single binary envelope: magic | version | salt | iv | tag | ciphertext
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const MAGIC = Buffer.from("OCXV1", "utf8");
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 });
}

export function encryptVault(plaintext: string | Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 8) {
    throw new Error("vault passphrase must be at least 8 characters");
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    MAGIC,
    Buffer.from([VERSION]),
    salt,
    iv,
    tag,
    encrypted,
  ]);
}

export function decryptVault(blob: Buffer, passphrase: string): Buffer {
  if (blob.length < MAGIC.length + 1 + SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error("vault blob is too short or corrupt");
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("vault blob has invalid magic (not an OpenCodex vault)");
  }
  const version = blob[MAGIC.length];
  if (version !== VERSION) throw new Error(`unsupported vault version ${version}`);
  let offset = MAGIC.length + 1;
  const salt = blob.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
  const iv = blob.subarray(offset, offset + IV_LEN); offset += IV_LEN;
  const tag = blob.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
  const encrypted = blob.subarray(offset);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  } catch {
    throw new Error("vault decrypt failed — wrong passphrase or corrupt file");
  }
}

export interface VaultPayload {
  version: 1;
  createdAt: string;
  /** Filename → utf8 content */
  files: Record<string, string>;
}

export function packVaultFiles(files: Record<string, string>): string {
  const payload: VaultPayload = {
    version: 1,
    createdAt: new Date().toISOString(),
    files,
  };
  return JSON.stringify(payload);
}

export function unpackVaultFiles(plaintext: Buffer): VaultPayload {
  const parsed = JSON.parse(plaintext.toString("utf8")) as VaultPayload;
  if (parsed?.version !== 1 || !parsed.files || typeof parsed.files !== "object") {
    throw new Error("vault payload schema invalid");
  }
  return parsed;
}
