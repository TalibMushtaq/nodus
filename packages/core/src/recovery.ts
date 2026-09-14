import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

// Account recovery identity (ADR-0002).
//
// The recovery phrase is a BIP39 mnemonic generated once at account creation
// and shown to the user for offline safekeeping. It deterministically derives
// an Ed25519 identity — the same primitive devices/nodes use — so the account's
// recovery public key can be published and every file/folder key sealed to it.
// The phrase itself never leaves the client: the Relay only ever stores the
// derived public key, and only a device holding the phrase can open the
// recovery envelopes.
//
// Derivation deliberately uses HKDF over the BIP39 seed (rather than the seed
// bytes directly) so the info string domain-separates this key from any other
// future use of the same phrase.

const RECOVERY_HKDF_INFO = new TextEncoder().encode("nodus-recovery-identity-v1");

/** 24 words / 256 bits of entropy — the v1 recovery phrase strength. */
const RECOVERY_ENTROPY_BITS = 256;

export interface RecoveryIdentity {
  /** 32-byte Ed25519 seed; treat with the same secrecy as a device private key. */
  privateKey: Uint8Array;
  /** 32-byte Ed25519 public key, published to the account. */
  publicKey: Uint8Array;
}

/** Generate a fresh 24-word BIP39 recovery phrase (all lowercase). */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, RECOVERY_ENTROPY_BITS);
}

/** Normalize whitespace/case so a phrase survives copy-paste formatting. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when `phrase` is a valid BIP39 mnemonic in the English wordlist. */
export function isValidRecoveryPhrase(phrase: string): boolean {
  return validateMnemonic(normalizeRecoveryPhrase(phrase), wordlist);
}

/**
 * Derive the account recovery Ed25519 identity from a phrase. Deterministic and
 * side-effect free; throws on an invalid mnemonic so a mistyped recovery phrase
 * fails loudly instead of producing a key that cannot open the envelopes.
 */
export function recoveryIdentityFromPhrase(phrase: string): RecoveryIdentity {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("recovery phrase is not a valid BIP39 mnemonic");
  }
  const seed = mnemonicToSeedSync(normalized);
  const privateKey = hkdf(sha256, seed, new Uint8Array(0), RECOVERY_HKDF_INFO, 32);
  return { privateKey, publicKey: ed25519.getPublicKey(privateKey) };
}

/**
 * Sign a Relay challenge with the recovery key, returning a hex signature. Used
 * for online recovery: the signature over the server-issued nonce proves the
 * client holds the phrase without transmitting it.
 */
export function signRecoveryChallenge(phrase: string, message: Uint8Array): string {
  const { privateKey } = recoveryIdentityFromPhrase(phrase);
  return bytesToHex(ed25519.sign(message, privateKey));
}
