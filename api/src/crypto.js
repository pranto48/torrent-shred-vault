import crypto from 'node:crypto';
import argon2 from 'argon2';

const ARGON_OPTIONS = { type: argon2.argon2id, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1 };

export async function hashPassword(password) { return argon2.hash(password, ARGON_OPTIONS); }
export async function verifyPassword(hash, password) { return argon2.verify(hash, password, ARGON_OPTIONS); }
export async function deriveKek(password, userSalt) {
  return argon2.hash(password, { ...ARGON_OPTIONS, hashLength: 32, raw: true, salt: userSalt });
}
export function generateDek() { return crypto.randomBytes(32); }

export function wrapDek(kek, dek) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function unwrapDek(kek, wrappedDek, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(wrappedDek), decipher.final()]);
}

export function encryptChunk(dek, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function decryptChunk(dek, ciphertext, iv, tag) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
