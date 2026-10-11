/** Real RSA ceremonies exercise browser response validation without platform authenticators. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { expect, it } from 'vitest'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { initializeAuthState } from '../src/state.ts'
import { authenticationOptions, registrationOptions, verifyAssertion, verifyRegistration } from '../src/webauthn.ts'

const origin = 'https://harness.example'
const challenge = Buffer.alloc(32, 7).toString('base64url')
const state = initializeAuthState({ publicOrigin: origin, rpId: 'harness.example', mountPath: '/' }, {
  algorithm: 'scrypt', N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024,
  salt: Buffer.alloc(32).toString('base64url'), hash: Buffer.alloc(64).toString('base64url'),
})
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' })
const coseKey = isoCBOR.encode(new Map<number, number | Buffer>([
  [1, 3], [3, -257], [-1, Buffer.from(jwk.n!, 'base64url')], [-2, Buffer.from(jwk.e!, 'base64url')],
]))
const rpHash = createHash('sha256').update('harness.example').digest()

function registration(options: { extensions?: RegistrationResponseJSON['clientExtensionResults']; context?: Record<string, unknown>; length?: number; flags?: number } = {}): RegistrationResponseJSON {
  const id = Buffer.alloc(options.length ?? 32, 9)
  const length = Buffer.alloc(2)
  length.writeUInt16BE(id.length)
  const authData = Buffer.concat([rpHash, Buffer.from([options.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, id, coseKey])
  return {
    id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key',
    response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false, ...options.context })).toString('base64url'),
      attestationObject: Buffer.from(isoCBOR.encode(new Map<string, string | Buffer | Map<string, never>>([
        ['fmt', 'none'], ['attStmt', new Map<string, never>()], ['authData', authData],
      ]))).toString('base64url'),
      transports: ['internal'],
    },
    clientExtensionResults: options.extensions ?? { credProps: { rk: true } },
  }
}

function assertion(id: string, context: Record<string, unknown> = {}, flags = 0x05): AuthenticationResponseJSON {
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false, ...context }))
  const authData = Buffer.concat([rpHash, Buffer.from([flags]), Buffer.alloc(4)])
  return {
    id, rawId: id, type: 'public-key', clientExtensionResults: {},
    response: {
      userHandle: state.userHandle, clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey).toString('base64url'),
    },
  }
}

it.each([{}, { credProps: {} }, { credProps: { rk: false } }, { credProps: { rk: true } }])('accepts RSA registration with optional extension output %j', async (extensions) => {
  const record = await verifyRegistration(registration({ extensions }), challenge, state, 'Laptop', 1000)
  expect(record).toMatchObject({ counter: 0, label: 'Laptop', transports: ['internal'], createdAt: 1000 })
  expect(record.publicKey).toBe(Buffer.from(coseKey).toString('base64url'))
  const verified = await verifyAssertion(assertion(record.id), challenge, { ...state, passkeys: [record] })
  expect(verified.info.userVerified).toBe(true)
})

it.each([
  { crossOrigin: true },
  { crossOrigin: true, topOrigin: 'https://other.example' },
  { crossOrigin: false, topOrigin: origin },
  { crossOrigin: 'false' },
])('rejects unexpected client context in both ceremonies: %j', async (context) => {
  await expect(verifyRegistration(registration({ context }), challenge, state, 'Laptop', 1000)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
  const record = await verifyRegistration(registration(), challenge, state, 'Laptop', 1000)
  await expect(verifyAssertion(assertion(record.id, context), challenge, { ...state, passkeys: [record] })).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
})

it('accepts an absent crossOrigin field from older clients', async () => {
  const record = await verifyRegistration(registration({ context: { crossOrigin: undefined } }), challenge, state, 'Laptop', 1000)
  const response = assertion(record.id, { crossOrigin: undefined })
  await expect(verifyAssertion(response, challenge, { ...state, passkeys: [record] }))
    .resolves.toMatchObject({ info: { userVerified: true } })
})

it('accepts 1023-byte credential IDs and rejects 1024-byte IDs inside authenticator data', async () => {
  await expect(verifyRegistration(registration({ length: 1023 }), challenge, state, 'Laptop', 1000)).resolves.toHaveProperty('id')
  const oversized = registration({ length: 1024 })
  await expect(verifyRegistration(oversized, challenge, state, 'Laptop', 1000)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
  oversized.id = oversized.rawId = registration().id
  await expect(verifyRegistration(oversized, challenge, state, 'Laptop', 1000)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
})

it.each([
  { context: { origin: 'https://other.example' } },
  { context: { challenge: 'wrong-challenge' } },
  { flags: 0x41 },
  { flags: 0x44 },
])('retains registration origin, challenge, presence and verification checks: %j', async (options) => {
  await expect(verifyRegistration(registration(options), challenge, state, 'Laptop', 1000)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
})

it('retains assertion signature, challenge and user verification checks', async () => {
  const record = await verifyRegistration(registration(), challenge, state, 'Laptop', 1000)
  const current = { ...state, passkeys: [record] }
  for (const response of [assertion(record.id, { challenge: 'wrong-challenge' }), assertion(record.id, {}, 0x01)]) {
    await expect(verifyAssertion(response, challenge, current)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
  }
  const response = assertion(record.id)
  response.response.signature = Buffer.alloc(256).toString('base64url')
  await expect(verifyAssertion(response, challenge, current)).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
})

it('requests discoverable user-verified credentials without restricting algorithm choice', async () => {
  const registration = await registrationOptions(state, 300000)
  expect(registration).toMatchObject({ attestation: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' } })
  expect(registration.pubKeyCredParams).toContainEqual({ type: 'public-key', alg: -257 })
  expect(await authenticationOptions(state, 300000)).toMatchObject({ allowCredentials: undefined, userVerification: 'required' })
})
