/**
 * Support-email builder for the dignified sync-paywall path (Wave 2). Pure
 * TypeScript with NO React Native, Expo, or @northkeep imports, so it is
 * unit-tested under Node (apps/mobile/test/sync-support-mail.test.ts).
 *
 * The mailto is to SUPPORT, not a purchase flow: App Store steering allows a
 * mailto to support (it is help, not a sale). The body carries ONLY the account
 * id, which the user is deliberately sending to support to get sync enabled. The
 * account id is derived from the device secret and reveals nothing about vault
 * content (see deriveSyncCreds); it is never a secret. The builder never touches
 * vault content, keys, or the device secret, and the test proves nothing but the
 * account id can appear in the body.
 */

/** Where sync-access requests go. Support address, not a purchase endpoint. */
export const SUPPORT_EMAIL = 'support@northkeep.ai';

/** Neutral subject line. No price, no link, no purchase verb. */
export const SUPPORT_MAIL_SUBJECT = 'NorthKeep sync access request';

/**
 * The email body. Contains ONLY the account id (when known); never vault
 * content, never a secret, never a key. When the account id could not be
 * derived, the body omits it and asks support to help identify the account.
 */
export function buildSupportMailBody(accountId: string | null): string {
  const idBlock = accountId
    ? `My account id is:\n${accountId}\n\n`
    : `I could not read my account id on this phone. Please help me identify my account.\n\n`;
  return (
    'Hello NorthKeep support,\n\n' +
    'I would like to turn on sync for my account.\n\n' +
    idBlock +
    'Thank you.'
  );
}

/**
 * A complete `mailto:` URL for React Native Linking.openURL. Subject and body
 * are percent-encoded. The address and scheme are steering-clean (no http, no
 * www, no price).
 */
export function buildSupportMailto(accountId: string | null): string {
  const subject = encodeURIComponent(SUPPORT_MAIL_SUBJECT);
  const body = encodeURIComponent(buildSupportMailBody(accountId));
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`;
}
