/** Machine-readable codes of client-side (non on-chain) failures. */
export type SdkErrorCode =
  // decoding
  | 'MANDATE_BAD_LENGTH'
  | 'MANDATE_BAD_DISCRIMINATOR'
  | 'MANDATE_UNSUPPORTED_VERSION'
  | 'MANDATE_BAD_PERMISSION_COUNT'
  | 'MANDATE_BAD_PERMISSION'
  | 'POLICY_BAD_LENGTH'
  | 'POLICY_BAD_DISCRIMINATOR'
  | 'POLICY_UNSUPPORTED_VERSION'
  | 'POLICY_BAD_FLAGS'
  | 'POLICY_BAD_CONFIG'
  | 'TOKEN_ACCOUNT_BAD_LENGTH'
  | 'MINT_BAD_LENGTH'
  | 'WRONG_OWNER_PROGRAM'
  | 'ADDRESS_MISMATCH'
  | 'BAD_ACCOUNT_DATA'
  // validation
  | 'BAD_HEX'
  | 'BAD_TIME'
  | 'U64_RANGE'
  | 'I64_RANGE'
  | 'U32_RANGE'
  | 'BAD_AMOUNT'
  | 'BAD_LIMIT'
  | 'ZERO_LIMIT_AMBIGUOUS'
  | 'BAD_DISCRIMINATOR'
  | 'TOO_MANY_DISCRIMINATORS'
  | 'EMPTY_DISCRIMINATORS'
  | 'DUPLICATE_DISCRIMINATOR'
  | 'BAD_ADDRESS'
  | 'MISSING_ADDRESS'
  | 'SAME_OWNER_AND_AGENT'
  | 'BAD_EXPIRY'
  | 'BAD_CONFIG'
  | 'BAD_UNITS'
  | 'BAD_DECIMALS'
  // transactions / client
  | 'TX_TOO_LARGE'
  | 'TX_SIGNER_UNSUPPORTED'
  | 'TX_EXPIRED'
  | 'TX_TIMEOUT'
  | 'NOT_DEPLOYED'
  | 'NOT_FOUND'
  // plans
  | 'PLAN_REFUSED'

/** Base class of every error thrown by the SDK itself (as opposed to program errors). */
export class SdkError extends Error {
  /** Stable machine-readable code. */
  readonly code: SdkErrorCode
  constructor(code: SdkErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** Raised when on-chain bytes do not look like what they claim to be. */
export class DecodeError extends SdkError {}

/** Raised when a caller-supplied input is invalid or unsafe; nothing was built. */
export class ValidationError extends SdkError {
  /**
   * Relay error code (100..119) the program would return for the same mistake, when there is one.
   * Lets callers map client-side rejections onto on-chain behaviour.
   */
  readonly relayCode: number | undefined
  constructor(
    code: SdkErrorCode,
    message: string,
    options?: { cause?: unknown; relayCode?: number },
  ) {
    super(code, message, options)
    this.relayCode = options?.relayCode
  }
}

/** Raised by plan builders that refuse an unsafe request. `reasons` lists every refusal. */
export class PlanRefusedError extends SdkError {
  readonly reasons: readonly string[]
  constructor(reasons: readonly string[]) {
    super('PLAN_REFUSED', `plan refused: ${reasons.join('; ')}`)
    this.reasons = reasons
  }
}
