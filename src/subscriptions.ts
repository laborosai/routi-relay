import { readFileSync } from 'node:fs'
import { AppStoreServerAPIClient, Environment, SignedDataVerifier, Status } from '@apple/app-store-server-library'

export type Subscription = { originalTransactionId: string; macId: string; expiresAt: number }
export type Purchase = { originalTransactionId: string; appAccountToken: string }
export interface AppleBilling {
  productId: string
  transaction(jws: string): Promise<Purchase>
  notification(jws: string): Promise<string | undefined>
  expiration(originalTransactionId: string, appAccountToken: string): Promise<number>
}

/** Apple checks signatures, app identity and environment; the API supplies current status. */
export function appleBilling(config: {
  bundleId: string; appAppleId: number; productId: string; sandbox: boolean;
  keyId: string; issuerId: string; keyFile: string; rootFiles: string[];
}): AppleBilling {
  if (typeof config.sandbox !== 'boolean' || !Number.isSafeInteger(config.appAppleId) || config.appAppleId <= 0
      || !config.bundleId || !config.productId || !config.keyId || !config.issuerId || !config.rootFiles?.length) {
    throw Error('Invalid Apple billing configuration')
  }
  const environment = config.sandbox ? Environment.SANDBOX : Environment.PRODUCTION
  const verifier = new SignedDataVerifier(config.rootFiles.map(path => readFileSync(path)), true,
    environment, config.bundleId, config.appAppleId)
  const api = new AppStoreServerAPIClient(readFileSync(config.keyFile, 'utf8'), config.keyId,
    config.issuerId, config.bundleId, environment)
  return {
    productId: config.productId,
    async transaction(jws) {
      const value = await verifier.verifyAndDecodeTransaction(jws)
      if (value.productId !== config.productId || !value.originalTransactionId || !value.appAccountToken
          || value.inAppOwnershipType !== 'PURCHASED') throw Error('Invalid Connect purchase')
      return { originalTransactionId: value.originalTransactionId, appAccountToken: value.appAccountToken.toLowerCase() }
    },
    async notification(jws) {
      const value = await verifier.verifyAndDecodeNotification(jws)
      if (!value.data?.signedTransactionInfo) return undefined
      return (await this.transaction(value.data.signedTransactionInfo)).originalTransactionId
    },
    async expiration(originalTransactionId, appAccountToken) {
      const result = await api.getAllSubscriptionStatuses(originalTransactionId)
      let expiresAt = 0
      for (const group of result.data ?? []) for (const item of group.lastTransactions ?? []) {
        if (item.originalTransactionId !== originalTransactionId || !item.signedTransactionInfo) continue
        const tx = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo)
        if (tx.productId !== config.productId || tx.appAccountToken?.toLowerCase() !== appAccountToken
            || tx.originalTransactionId !== originalTransactionId || tx.revocationDate
            || tx.inAppOwnershipType !== 'PURCHASED') continue
        if (item.status === Status.ACTIVE) expiresAt = Math.max(expiresAt, tx.expiresDate ?? 0)
        if (item.status === Status.BILLING_GRACE_PERIOD && item.signedRenewalInfo) {
          const renewal = await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo)
          expiresAt = Math.max(expiresAt, renewal.gracePeriodExpiresDate ?? 0)
        }
      }
      return expiresAt
    },
  }
}
