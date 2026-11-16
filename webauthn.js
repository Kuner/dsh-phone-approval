// Minimal, dependency-free WebAuthn (passkey) verification for one ES256 credential.
// Registration uses attestation "none": the enrolled key is trusted because enrollment
// itself is gated by a one-time approval link. Every assertion is fully verified:
// challenge, origin, RP ID hash, user presence + user verification flags, and signature.

import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'

export const b64url = buf => Buffer.from(buf).toString('base64url')
export const unb64url = str => Buffer.from(String(str ?? ''), 'base64url')
const sha256 = data => createHash('sha256').update(data).digest()

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

/** Decode one CBOR item at `pos`; returns [value, nextPos]. Supports the subset WebAuthn uses. */
export function cborDecode(buf, pos = 0) {
  if (pos >= buf.length) throw new Error('cbor: truncated input')
  const initial = buf[pos++]
  const major = initial >> 5
  const info = initial & 31
  let length
  if (info < 24) length = info
  else if (info === 24) { length = buf.readUInt8(pos); pos += 1 }
  else if (info === 25) { length = buf.readUInt16BE(pos); pos += 2 }
  else if (info === 26) { length = buf.readUInt32BE(pos); pos += 4 }
  else if (info === 27) { length = Number(buf.readBigUInt64BE(pos)); pos += 8 }
  else throw new Error('cbor: indefinite lengths are not supported')
  switch (major) {
    case 0: return [length, pos]
    case 1: return [-1 - length, pos]
    case 2: {
      if (pos + length > buf.length) throw new Error('cbor: truncated byte string')
      return [buf.subarray(pos, pos + length), pos + length]
    }
    case 3: {
      if (pos + length > buf.length) throw new Error('cbor: truncated text string')
      return [buf.toString('utf8', pos, pos + length), pos + length]
    }
    case 4: {
      const items = []
      for (let i = 0; i < length; i++) {
        const [item, next] = cborDecode(buf, pos)
        items.push(item)
        pos = next
      }
      return [items, pos]
    }
    case 5: {
      const map = new Map()
      for (let i = 0; i < length; i++) {
        const [key, afterKey] = cborDecode(buf, pos)
        const [value, afterValue] = cborDecode(buf, afterKey)
        map.set(key, value)
        pos = afterValue
      }
      return [map, pos]
    }
    case 7: {
      if (info === 20) return [false, pos]
      if (info === 21) return [true, pos]
      if (info === 22 || info === 23) return [null, pos]
      throw new Error('cbor: unsupported simple value')
    }
    default: throw new Error(`cbor: unsupported major type ${major}`)
  }
}

function parseAuthData(authData) {
  if (authData.length < 37) throw new Error('authenticator data too short')
  const rpIdHash = authData.subarray(0, 32)
  const flags = authData[32]
  const signCount = authData.readUInt32BE(33)
  const result = { rpIdHash, flags, signCount }
  if (flags & FLAG_AT) {
    let pos = 37 + 16 // skip AAGUID
    const idLength = authData.readUInt16BE(pos)
    pos += 2
    result.credentialId = authData.subarray(pos, pos + idLength)
    pos += idLength
    const [coseKey] = cborDecode(authData, pos)
    result.coseKey = coseKey
  }
  return result
}

function coseToJwk(coseKey) {
  if (!(coseKey instanceof Map)) throw new Error('credential public key is not a COSE map')
  const kty = coseKey.get(1)
  const alg = coseKey.get(3)
  const crv = coseKey.get(-1)
  const x = coseKey.get(-2)
  const y = coseKey.get(-3)
  if (kty !== 2 || alg !== -7 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new Error('only ES256 (P-256) passkeys are supported')
  }
  return { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }
}

function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let clientData
  try {
    clientData = JSON.parse(clientDataJSON.toString('utf8'))
  } catch {
    throw new Error('clientDataJSON is not JSON')
  }
  if (clientData.type !== type) throw new Error(`unexpected clientData type ${clientData.type}`)
  if (clientData.challenge !== challenge) throw new Error('challenge mismatch')
  if (clientData.origin !== origin) throw new Error(`origin mismatch (${clientData.origin})`)
  if (clientData.crossOrigin === true) throw new Error('cross-origin ceremony rejected')
}

function checkAuthFlags(parsed, rpId) {
  if (!parsed.rpIdHash.equals(sha256(rpId))) throw new Error('RP ID hash mismatch')
  if (!(parsed.flags & FLAG_UP)) throw new Error('user presence flag missing')
  if (!(parsed.flags & FLAG_UV)) throw new Error('user verification (Face ID) flag missing')
}

/**
 * Verify a registration ceremony and return the credential to store.
 * @param body - { id, clientDataJSON, attestationObject } as base64url strings.
 * @param expected - { challenge, origin, rpId }.
 */
export function verifyRegistration(body, expected) {
  const clientDataJSON = unb64url(body?.clientDataJSON)
  checkClientData(clientDataJSON, { type: 'webauthn.create', ...expected })
  const [attestation] = cborDecode(unb64url(body?.attestationObject))
  if (!(attestation instanceof Map) || !Buffer.isBuffer(attestation.get('authData'))) {
    throw new Error('malformed attestation object')
  }
  const parsed = parseAuthData(attestation.get('authData'))
  checkAuthFlags(parsed, expected.rpId)
  if (!parsed.credentialId || !parsed.coseKey) throw new Error('attested credential data missing')
  const jwk = coseToJwk(parsed.coseKey)
  // Make sure node can load the key before it is persisted.
  createPublicKey({ key: jwk, format: 'jwk' })
  return {
    credentialId: b64url(parsed.credentialId),
    jwk,
    signCount: parsed.signCount,
    rpId: expected.rpId,
    createdAt: Date.now(),
  }
}

/**
 * Verify an assertion against the stored credential.
 * @param body - { id, clientDataJSON, authenticatorData, signature } as base64url strings.
 * @param credential - the stored credential from verifyRegistration().
 * @param expected - { challenge, origin, rpId }.
 * @returns the new sign count.
 */
export function verifyAssertion(body, credential, expected) {
  if (body?.id !== credential.credentialId) throw new Error('unknown passkey')
  const clientDataJSON = unb64url(body.clientDataJSON)
  checkClientData(clientDataJSON, { type: 'webauthn.get', ...expected })
  const authData = unb64url(body.authenticatorData)
  const parsed = parseAuthData(authData)
  checkAuthFlags(parsed, expected.rpId)
  const key = createPublicKey({ key: credential.jwk, format: 'jwk' })
  const signed = Buffer.concat([authData, sha256(clientDataJSON)])
  const ok = cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, unb64url(body.signature))
  if (!ok) throw new Error('signature verification failed')
  // Synced passkeys (iCloud Keychain) always report 0; only enforce growth when counters are used.
  if (parsed.signCount !== 0 || credential.signCount !== 0) {
    if (parsed.signCount <= credential.signCount) throw new Error('sign counter did not increase (possible cloned key)')
  }
  return parsed.signCount
}
