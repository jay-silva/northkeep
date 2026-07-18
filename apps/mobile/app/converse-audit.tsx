import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { colors } from '../src/ui';
import { getLastAudit } from '../src/lib/converse-run';

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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'What left this device' }} />
      {audit === null ? (
        <Text style={styles.empty}>Send a message in Converse first — then this shows exactly what was transmitted.</Text>
      ) : (
        <>
          <View style={styles.metaCard}>
            <Row label="Provider" value={audit.providerLabel} />
            <Row label="Endpoint" value={audit.outbound.endpoint} />
            <Row label="Host" value={audit.endpointHost} />
            <Row label="Model" value={audit.outbound.model} />
            <Row label="Privacy" value={audit.privacy === 'bounded' ? 'Bounded (leaves device)' : 'Private (on your network)'} />
            <Row label="Redaction" value={`Tier ${audit.tierApplied} applied`} />
            <Row label="Sent" value={new Date(audit.at).toLocaleString()} />
          </View>

          {audit.redactions.length > 0 ? (
            <>
              <Text style={styles.sectionTitle}>What was masked on your phone</Text>
              <View style={styles.metaCard}>
                {audit.redactions.map((r, i) => (
                  <View key={i} style={styles.maskRow}>
                    <Text style={styles.maskOriginal} numberOfLines={1}>
                      {r.original}
                    </Text>
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
            This is the message body exactly as sent. Masked tokens like [EMAIL_1], [DATE-1948], or
            Person-1 replaced the real values before transmission — the list above shows each one.
            Shown here only, never stored. Your API key is not shown — it is a request header, never
            part of this body.
          </Text>

          <Text style={styles.sectionTitle}>Outbound messages</Text>
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
      <Text style={styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 48 },
  empty: { color: colors.muted, fontSize: 15, lineHeight: 22, padding: 20, textAlign: 'center' },
  metaCard: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  rowLabel: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  rowValue: { color: colors.text, fontSize: 13, flex: 1, textAlign: 'right' },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 14 },
  sectionTitle: {
    color: colors.text,
    fontSize: 13,
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
  role: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 6 },
  maskRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  maskOriginal: { color: '#c0625a', fontSize: 13, textDecorationLine: 'line-through', flexShrink: 1 },
  maskArrow: { color: colors.muted, fontSize: 13 },
  maskPlaceholder: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  maskKind: { color: colors.muted, fontSize: 11 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
});
