import argon2 from "argon2";

// argon2id with library defaults (m=65536 KiB, t=3, p=4) — OWASP-recommended range.
export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });

let dummyHash: Promise<string> | null = null;

/** Verifies a password; when the user does not exist a dummy hash is checked so timing does not reveal it. */
export async function verifyPassword(hash: string | null, password: string): Promise<boolean> {
  if (!hash) {
    dummyHash ??= hashPassword("not-a-real-password-for-timing");
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}
