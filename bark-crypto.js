// Bark end-to-end push encryption (https://bark.day.app/#/encryption).
//
// The Bark app decrypts `ciphertext` with the key saved under Push Encryption and,
// when the push carries an `iv`, uses that IV instead of the saved one. We use
// AES-256-CBC with PKCS#7 padding and a fresh random IV per push; key and IV are
// ASCII strings whose UTF-8 bytes are the AES key and IV, exactly as the app reads them.

import { createCipheriv, createDecipheriv, randomInt } from 'node:crypto'

export const ALGORITHM = 'AES256'
export const MODE = 'CBC'
export const PADDING = 'pkcs7'
const KEY_LENGTH = 32
const IV_LENGTH = 16

// Unambiguous characters, so a key can also be typed on the phone if pasting fails.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

export function randomText(length) {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

export const generateKey = () => randomText(KEY_LENGTH)
export const generateIv = () => randomText(IV_LENGTH)

export function isValidKey(key) {
  return typeof key === 'string' && Buffer.byteLength(key, 'utf8') === KEY_LENGTH
}

/**
 * Encrypt one Bark push.
 * @param fields - the Bark parameters to hide (title, body, url, group, level, ...).
 * @param key - 32-character ASCII key, as entered in the Bark app.
 * @returns { ciphertext, iv } to send as Bark request parameters.
 */
export function encryptPush(fields, key, iv = generateIv()) {
  if (!isValidKey(key)) throw new Error('encryption key must be 32 ASCII characters')
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(fields), 'utf8'), cipher.final()]).toString('base64')
  return { ciphertext, iv }
}

/** Inverse of encryptPush, for tests. */
export function decryptPush({ ciphertext, iv }, key) {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'utf8'), Buffer.from(iv, 'utf8'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'))
}
