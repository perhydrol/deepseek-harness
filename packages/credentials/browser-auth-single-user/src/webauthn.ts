/** SimpleWebAuthn verification with mandatory user verification and exact deployment binding. */
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { z } from 'zod'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { AuthState, PasskeyRecord } from '@hydrogen/dsh-browser-auth'

const encoded = z.string().min(1).max(1048576).regex(/^[A-Za-z0-9_-]+$/)
const common = {
  id: encoded, rawId: encoded, type: z.literal('public-key'),
}
const assertion: z.ZodType<AuthenticationResponseJSON> = z.object({
  ...common,
  response: z.object({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded }),
  clientExtensionResults: z.object({}),
})
const attestation: z.ZodType<RegistrationResponseJSON> = z.object({
  ...common,
  response: z.object({ clientDataJSON: encoded, attestationObject: encoded, transports: z.array(z.string()).max(16).default([]) }),
  clientExtensionResults: z.object({ credProps: z.object({ rk: z.literal(true) }) }),
})
const transports = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const

/**
 * Generate discoverable user-verified passkey assertion options.
 * @param state - committed deployment and operator handle.
 * *
 * @param timeout - challenge lifetime.
 * *
 * @returns discoverable assertion options.
 */
export function authenticationOptions(state: Readonly<AuthState>, timeout: number): ReturnType<typeof generateAuthenticationOptions> {
  return generateAuthenticationOptions({
    rpID: state.deployment.rpId, userVerification: 'required', timeout,
  })
}

/**
 * Generate resident user-verified passkey registration options.
 * @param state - committed deployment and existing keys.
 * *
 * @param timeout - registration lifetime.
 * *
 * @returns resident credential creation options.
 */
export function registrationOptions(state: Readonly<AuthState>, timeout: number): ReturnType<typeof generateRegistrationOptions> {
  return generateRegistrationOptions({
    rpName: 'DeepSeek Harness', rpID: state.deployment.rpId,
    userID: Buffer.from(state.userHandle, 'base64url'), userName: 'operator', userDisplayName: 'Operator',
    timeout, attestationType: 'none', extensions: { credProps: true },
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: state.passkeys.map(key => ({ id: key.id, transports: [...key.transports] })),
  })
}

/**
 * Verify a discoverable assertion against one persisted public key.
 * *
 * @param value - untrusted browser JSON.
 * *
 * @param challenge - consumed expected challenge.
 * *
 * @param state - committed singleton captured before verification.
 * *
 * @returns verified credential revision and counter update for an atomic subsequent transaction.
 */
export async function verifyAssertion(value: unknown, challenge: string, state: Readonly<AuthState>): Promise<{ credential: PasskeyRecord; info: Awaited<ReturnType<typeof verifyAuthenticationResponse>>['authenticationInfo'] }> {
  const parsed = assertion.safeParse(value)
  if (!parsed.success || parsed.data.response.userHandle !== state.userHandle || parsed.data.id !== parsed.data.rawId) {
    throw invalidCredential()
  }
  const credential = state.passkeys.find(key => key.id === parsed.data.id)
  if (credential === undefined) throw invalidCredential()
  try {
    const result = await verifyAuthenticationResponse({
      response: parsed.data, expectedChallenge: challenge,
      expectedOrigin: state.deployment.publicOrigin, expectedRPID: state.deployment.rpId,
      requireUserVerification: true,
      credential: {
        id: credential.id, publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter, transports: [...credential.transports],
      },
    })
    if (!result.verified || !result.authenticationInfo.userVerified) throw invalidCredential()
    return { credential, info: result.authenticationInfo }
  } catch (error) { throw invalidCredential(error) }
}

/**
 * Verify registration before persisting any credential.
 * *
 * @param value - untrusted browser JSON.
 * *
 * @param challenge - consumed registration challenge.
 * *
 * @param state - captured deployment and operator identity.
 * *
 * @param label - validated user-visible label.
 * *
 * @param now - registration time.
 * *
 * @returns public credential metadata without attestation or private keys.
 */
export async function verifyRegistration(
  value: unknown,
  challenge: string,
  state: Readonly<AuthState>,
  label: string,
  now: number,
): Promise<PasskeyRecord> {
  const parsed = attestation.safeParse(value)
  if (!parsed.success || parsed.data.id !== parsed.data.rawId) throw invalidCredential()
  try {
    const result = await verifyRegistrationResponse({
      response: parsed.data, expectedChallenge: challenge,
      expectedOrigin: state.deployment.publicOrigin, expectedRPID: state.deployment.rpId,
      requireUserVerification: true, requireUserPresence: true,
    })
    if (!result.verified || !result.registrationInfo.userVerified) throw invalidCredential()
    const info = result.registrationInfo
    return {
      id: info.credential.id as PasskeyRecord['id'],
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'), counter: info.credential.counter,
      revision: 1, transports: (info.credential.transports ?? []).filter(isTransport),
      deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
      label, createdAt: now, lastUsedAt: null,
    }
  } catch (error) { throw invalidCredential(error) }
}
function isTransport(value: string): value is PasskeyRecord['transports'][number] {
  return transports.some(transport => transport === value)
}
function invalidCredential(cause?: unknown): AuthError {
  return new AuthError('auth/invalid-credentials', 'Passkey verification failed; start again.', { cause })
}
