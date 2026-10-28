/**
 * Account-id grammar from nearcore / NEAR docs:
 * https://docs.near.org/protocol/accounts-contracts/account-id
 * length 2..=64 and
 * /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
 */
const ACCOUNT_ID_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Implicit account: 64 lowercase hex chars (the ed25519 public key). */
const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;

export type NearNetworkId = 'testnet' | 'mainnet';

export function isValidNearAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT_ID_RE.test(id);
}

/**
 * Payees we will sign for. Named accounts must use the network's top-level
 * suffix (`.testnet` or `.near`). A 64-char lowercase hex implicit account is
 * accepted on either network. The id must also pass `isValidNearAccountId`.
 */
export function isAcceptedPayee(id: string, networkId: NearNetworkId): boolean {
  if (!isValidNearAccountId(id)) {
    return false;
  }
  if (IMPLICIT_ACCOUNT_RE.test(id)) {
    return true;
  }
  if (networkId === 'testnet') {
    return id.endsWith('.testnet');
  }
  if (networkId === 'mainnet') {
    return id.endsWith('.near');
  }
  return false;
}
