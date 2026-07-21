/**
 * Effective outbound-redaction tier labels shown at provider-selection time
 * (Wave 2, disclosure only). Pure TypeScript with NO React Native / Expo /
 * @northkeep imports, so the availability -> copy mapping is unit-tested under
 * Node (apps/mobile/test/redaction-tier.test.ts).
 *
 * WHY THIS EXISTS: cloud chat pseudonymizes names on-device via the NLTagger
 * name net (nltagger-ner.ts), which ships in every iOS, so Tier 2 is the
 * universal posture on iPhone; where the net is absent (Android/unsupported) the
 * deterministic Tier-1 floor is all that runs and unusual names can slip through
 * (converse.tsx's warn banner). Surfacing the same fact at selection time means
 * the user learns the posture before choosing a provider, not after they are
 * already in the composer.
 *
 * SCOPE: labels only. This module changes no redaction or send behavior; it
 * maps a boolean the app already computes (NLTagger native module present, the
 * exact condition converse.tsx uses for the name net) into calm copy.
 *
 * ALIGNMENT: the Tier-2 / Tier-1 strings are kept factual and consistent with
 * the converse.tsx banner so the two surfaces never contradict.
 */

/** Cloud chat WITH the on-device NER pass (NLTagger present, universal on iOS). */
export const TIER2_ONDEVICE_LABEL = 'Tier 2: names pseudonymized on device';

/** Cloud chat WITHOUT the on-device NER pass: the deterministic floor only. */
export const TIER1_ONLY_LABEL =
  'Tier 1 only: emails, phones, and IDs masked; unusual names can slip through.';

/** On-device chat: nothing is sent, so there is nothing to redact outbound. */
export const ON_DEVICE_PRIVATE_LABEL = 'Fully private: nothing leaves this device.';

/**
 * One-line intro shown above the provider list. Explains what the tier means
 * and that on-device chat is always fully private. References the in-app "What
 * left this device" view by name only (no external link).
 */
export const PROVIDER_TIER_INTRO =
  'These tiers show what is masked before a message leaves this phone; on-device chat is always fully private, and "What left this device" shows the proof after any cloud chat.';

/**
 * Map on-device Tier-2 availability to the effective outbound tier label for a
 * CLOUD provider. `true` when the NLTagger name net is present on this phone
 * (universal on iOS), so the redacted prompt gets the pseudonymization pass;
 * `false` when only the deterministic Tier-1 shield runs (e.g. Android).
 */
export function effectiveTierLabel(tier2Available: boolean): string {
  return tier2Available ? TIER2_ONDEVICE_LABEL : TIER1_ONLY_LABEL;
}
