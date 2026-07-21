import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { colors, type, useAnnounce } from '../src/ui';
import { getLastAudit } from '../src/lib/converse-run';
import { TIER2_UNAVAILABLE_MESSAGE, partialNerFailureMessage } from '../src/lib/ner-degrade';

/**
 * "What left this device" (M6-3 acceptance). Shows the EXACT payload sent to the
 * model provider on the last turn — the message body handed to the request,
 * after the Tier-1 redaction firewall ran. Secrets seeded into the conversation
 * (emails, cards, SSNs, API keys, phones, IPs) appear here as [EMAIL_1] /
 * [CREDIT_CARD_1] / [SSN_1] etc., proving they were masked before transmission.
 *
 * The API key is NOT here by construction: it travels as a request HEADER, and
 * this view renders the request BODY only. There is no code path that puts a key
 * into this screen.
 */
export default function ConverseAudit() {
  const audit = getLastAudit();

  // Invariant #6, now audible: if the Tier-2 name net did not run (or ran only
  // partially) this turn, announce that degradation to VoiceOver when the audit
  // opens. Content-free by construction (ids/pass names only, never memory text).
  const degradeWarning =
    audit && !audit.onDevice
      ? audit.tier2Degraded
        ? TIER2_UNAVAILABLE_MESSAGE
        : audit.failedPasses.length > 0
          ? partialNerFailureMessage(audit.failedPasses)
          : null
      : null;
  useAnnounce(degradeWarning);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'What left this device' }} />
      {audit === null ? (
        <Text style={styles.empty}>Send a message in Converse first — then this shows exactly what was transmitted.</Text>
      ) : (
        <>
          {audit.onDevice ? (
            <View style={styles.deviceBanner}>
              <Text style={styles.deviceBannerText}>
                This turn stayed on this device. Nothing was sent. The text below is what the
                on-device model was given locally, never transmitted anywhere.
              </Text>
            </View>
          ) : null}

          {/* Degrade honesty (invariant #6): if the Tier-2 name net did not
              run, or ran only partially, say so HERE, next to the payload it
              affected. Content-free: pass ids only, never text. */}
          {!audit.onDevice && audit.tier2Degraded ? (
            <View style={styles.warnCard} accessibilityLiveRegion="assertive" accessibilityRole="alert">
              <Text style={styles.warnCardText}>{TIER2_UNAVAILABLE_MESSAGE}</Text>
            </View>
          ) : null}
          {!audit.onDevice && !audit.tier2Degraded && audit.failedPasses.length > 0 ? (
            <View style={styles.warnCard} accessibilityLiveRegion="assertive" accessibilityRole="alert">
              <Text style={styles.warnCardText}>
                {partialNerFailureMessage(audit.failedPasses)}
              </Text>
            </View>
          ) : null}

          <View style={styles.metaCard}>
            <Row label="Provider" value={audit.providerLabel} />
            <Row label={audit.onDevice ? 'Ran on' : 'Endpoint'} value={audit.outbound.endpoint} />
            <Row label="Host" value={audit.endpointHost} />
            <Row label="Model" value={audit.outbound.model} />
            <Row
              label="Privacy"
              value={
                audit.onDevice
                  ? 'On device (nothing sent)'
                  : audit.privacy === 'bounded'
                    ? 'Bounded (leaves device)'
                    : 'Private (on your network)'
              }
            />
            <Row label="Redaction" value={audit.onDevice ? 'On-device, no redaction needed' : `Tier ${audit.tierApplied} applied`} />
            <Row label={audit.onDevice ? 'Ran' : 'Sent'} value={new Date(audit.at).toLocaleString()} />
          </View>

          {audit.redactions.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>What was masked on your phone</Text>
              <View style={styles.metaCard}>
                {audit.redactions.map((r, i) => (
                  <View key={i} style={styles.maskRow}>
                    <Text style={styles.maskOriginal}>{r.original}</Text>
                    <Text style={styles.maskArrow}>→</Text>
                    <Text style={styles.maskPlaceholder}>{r.placeholder}</Text>
                    <Text style={styles.maskKind}>{KIND_LABEL[r.kind] ?? r.kind}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : (
            <Text style={styles.note}>Nothing sensitive was found to mask in this turn.</Text>
          )}

          <Text style={styles.note}>
            {audit.onDevice
              ? 'This is the exact text the on-device model processed locally. It was never transmitted. No API key is involved in on-device chat.'
              : 'This is the message body exactly as sent. Masked tokens like [EMAIL_1], [DATE-1948], or Person-1 replaced the real values before transmission; the list above shows each one. Shown here only, never stored. Your API key is not shown; it is a request header, never part of this body.'}
          </Text>

          <Text style={styles.sectionTitle}>{audit.onDevice ? 'On-device messages (not sent)' : 'Outbound messages'}</Text>
          {audit.outbound.messages.map((m, i) => (
            <View key={i} style={styles.msgCard}>
              <Text style={styles.role}>{m.role.toUpperCase()}</Text>
              <Text style={styles.body} selectable>
                {m.content}
              </Text>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const KIND_LABEL: Record<string, string> = {
  email: 'email', phone: 'phone', ssn: 'SSN', credit_card: 'card', ip: 'IP',
  api_key: 'API key', iban: 'IBAN', person: 'name', org: 'org',
  location: 'location', date: 'date (year kept)', record_id: 'record/policy #', gps: 'GPS', zip: 'ZIP', address: 'address',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      {/* Identity fields (endpoint, host, model): wrap fully, never truncate. */}
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48 },
  empty: { ...type.body, color: colors.muted, lineHeight: 22, padding: 20, textAlign: 'center' },
  deviceBanner: {
    backgroundColor: '#1c2b23',
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  deviceBannerText: { ...type.subhead, color: colors.accent, fontWeight: '600' },
  warnCard: {
    backgroundColor: colors.warnBg,
    borderRadius: 10,
    padding: 14,
    marginBottom: 14,
  },
  warnCardText: { ...type.subhead, color: colors.warnText, fontWeight: '600' },
  metaCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  rowLabel: { ...type.footnote, color: colors.muted, fontWeight: '600' },
  rowValue: { ...type.footnote, color: colors.text, flex: 1, textAlign: 'right' },
  note: { ...type.footnote, color: colors.muted, marginTop: 14 },
  sectionTitle: {
    ...type.footnote,
    color: colors.text,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 20,
    marginBottom: 10,
  },
  msgCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  role: { ...type.caption, color: colors.accent, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 },
  maskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  // colors.removed (#f0716b) = 5.76:1 on card; was #c0625a at 4.07:1 (WCAG fail).
  maskOriginal: { ...type.footnote, color: colors.removed, textDecorationLine: 'line-through', flexShrink: 1 },
  maskArrow: { ...type.footnote, color: colors.muted },
  maskPlaceholder: { ...type.footnote, color: colors.accent, fontWeight: '600' },
  maskKind: { ...type.caption, color: colors.muted, fontWeight: '400' },
  body: { ...type.subhead, color: colors.text },
});
