import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorNote, WarningBanner, colors } from '../src/ui';
import { runOnDeviceRedactionEval, type OnDeviceRedactionEval } from '../src/lib/local-eval';

/**
 * On-device redaction eval (M6-4 GATE, ADR 0023). Runs the seeded corpus through
 * the SHIPPED Tier-3 pipeline (deterministic dictionary floor + the NLTagger
 * name net) on THIS phone. The headline is the Tier-3 no-leak rate (production
 * truth), shown next to the dictionary-only floor so the NER net's contribution
 * is legible, plus the floor-monotonicity safety metric that must always read
 * zero. The Tier-2 model-in-isolation recall is kept below, clearly labeled as a
 * diagnostic, NOT the shipped posture. Numbers are produced on this device;
 * there is no baked-in result.
 */

export default function ModelEval() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnDeviceRedactionEval | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      setResult(await runOnDeviceRedactionEval((done, total) => setProgress({ done, total })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The evaluation failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>On-device redaction eval</Text>
      <Text style={styles.body}>
        Runs the seeded corpus through the shipped Tier-3 pipeline on this phone: the
        deterministic name dictionary as the floor, plus the on-device NLTagger name net on top.
        It reports how many names still reach the wire (production truth), the dictionary-only
        floor for comparison, and the safety check that the net never falls below that floor.
      </Text>

      <Button title={busy ? 'Running...' : 'Run evaluation'} onPress={() => void run()} busy={busy} style={styles.btn} />
      {busy ? (
        <View style={styles.progressWrap}>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: progress ? `${Math.round((progress.done / progress.total) * 100)}%` : '4%' },
              ]}
            />
          </View>
          <Text style={styles.progressText}>
            {progress
              ? `Step ${progress.done} of ${progress.total}`
              : 'Warming up the on-device name net...'}
          </Text>
        </View>
      ) : null}
      <ErrorNote message={error} />

      {result?.status === 'unavailable' ? (
        <WarningBanner message={result.reason} />
      ) : null}

      {result?.status === 'ok' ? <Report result={result} /> : null}
    </ScrollView>
  );
}

function Report({ result }: { result: Extract<OnDeviceRedactionEval, { status: 'ok' }> }) {
  const { tier3, tier2Diagnostic } = result.report;
  const fullPct = (tier3.fullNoLeakRate * 100).toFixed(1);
  const floorPct = (tier3.floorNoLeakRate * 100).toFixed(1);
  const violations = tier3.violations;
  const monotonicityOk = violations.length === 0;

  const verdict = !monotonicityOk
    ? { label: 'FAIL: NER net fell below the dictionary floor', color: colors.danger }
    : tier3.fullNoLeakRate >= 1
      ? { label: 'No names reached the wire', color: colors.accent }
      : tier3.fullNoLeakRate >= tier3.floorNoLeakRate
        ? { label: 'Net holds at or above the floor', color: colors.accent }
        : { label: 'Below floor: investigate', color: colors.warnText };

  return (
    <View style={styles.report}>
      {/* ---- Production truth: Tier-3 pipeline ---- */}
      <Text style={styles.sectionTag}>Tier-3 pipeline (shipped)</Text>
      <View style={styles.headline}>
        <Text style={styles.recall}>{fullPct}%</Text>
        <Text style={styles.recallLabel}>names with no token reaching the wire (production truth)</Text>
      </View>
      <Text style={[styles.verdict, { color: verdict.color }]}>{verdict.label}</Text>

      <Row label="Dictionary-only floor" value={`${floorPct}%  no-leak`} />
      <Row label="Full pipeline (dict + net)" value={`${fullPct}%  no-leak`} />
      <Row label="Person names scored" value={`${tier3.personNames}`} />
      <Row label="Cases" value={`${tier3.cases}`} />

      {/* ---- The safety metric, loud ---- */}
      {monotonicityOk ? (
        <View style={styles.okBanner}>
          <Text style={styles.okBannerText}>
            Floor-monotonicity holds: 0 violations. The net never left a name the dictionary masks.
          </Text>
        </View>
      ) : (
        <View style={styles.alarmBanner}>
          <Text style={styles.alarmTitle}>MONOTONICITY VIOLATIONS: {violations.length}</Text>
          <Text style={styles.alarmSub}>
            The full pipeline left a name token in plaintext that the dictionary floor masks. This is
            a real leak class. Do not ship.
          </Text>
          {violations.slice(0, 20).map((v, i) => (
            <Text key={i} style={styles.alarmLine}>
              leaked "{v.leakedToken}" of "{v.expectedName}"
            </Text>
          ))}
        </View>
      )}

      {tier3.fullLeaks.length > 0 ? (
        <View style={styles.misses}>
          <Text style={styles.missesTitle}>Names still reaching the wire ({tier3.fullLeaks.length})</Text>
          {tier3.fullLeaks.slice(0, 20).map((l, i) => (
            <Text key={i} style={styles.missLine}>
              {l.name}: {l.survivingTokens.join(', ')}
            </Text>
          ))}
        </View>
      ) : null}

      {/* ---- Diagnostic: NER model in isolation (NOT the shipped number) ---- */}
      <View style={styles.diagBlock}>
        <Text style={styles.sectionTag}>Diagnostic only: NER model in isolation</Text>
        <Text style={styles.diagNote}>
          Tier-2 recall with NO dictionary floor under it. This is a health signal for the name net,
          not the shipped posture. Production ships Tier-3 above.
        </Text>
        <Row
          label="Strict recall (span + kind)"
          value={`${(tier2Diagnostic.entities.recall * 100).toFixed(1)}%`}
        />
        <Row
          label="Entities caught"
          value={`${tier2Diagnostic.entities.caught} / ${tier2Diagnostic.entities.total}`}
        />
        <Row label="Span recall (any kind)" value={`${(tier2Diagnostic.spanRecall * 100).toFixed(1)}%`} />
        {(['person', 'org', 'location'] as const).map((k) => (
          <Row
            key={k}
            label={`  ${k}`}
            value={`${(tier2Diagnostic.byKind[k].recall * 100).toFixed(0)}%  (${tier2Diagnostic.byKind[k].caught}/${tier2Diagnostic.byKind[k].total})`}
          />
        ))}
        <Row
          label="Tier-1 floor"
          value={
            tier2Diagnostic.tier1Leaks.length === 0
              ? `held (${tier2Diagnostic.tier1SecretsChecked} secrets)`
              : `LEAKED ${tier2Diagnostic.tier1Leaks.length}`
          }
        />
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, gap: 4 },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  body: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 16 },
  progressWrap: { marginTop: 14, gap: 6 },
  progressTrack: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: colors.accent },
  progressText: { color: colors.muted, fontSize: 13 },
  btn: { marginBottom: 8 },
  report: { marginTop: 16, backgroundColor: colors.card, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: 16 },
  sectionTag: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 },
  headline: { alignItems: 'center', marginBottom: 8 },
  recall: { color: colors.text, fontSize: 44, fontWeight: '800' },
  recallLabel: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  verdict: { fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  okBanner: { marginTop: 16, backgroundColor: colors.card, borderRadius: 10, borderWidth: 1, borderColor: colors.accent, padding: 12 },
  okBannerText: { color: colors.accent, fontSize: 13, lineHeight: 19, fontWeight: '600' },
  alarmBanner: { marginTop: 16, backgroundColor: colors.card, borderRadius: 10, borderWidth: 2, borderColor: colors.danger, padding: 12 },
  alarmTitle: { color: colors.danger, fontSize: 15, fontWeight: '800', marginBottom: 6 },
  alarmSub: { color: colors.danger, fontSize: 13, lineHeight: 19, marginBottom: 8 },
  alarmLine: { color: colors.text, fontSize: 13, lineHeight: 20 },
  diagBlock: { marginTop: 24, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  diagNote: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 10 },
  misses: { marginTop: 16 },
  missesTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  missLine: { color: colors.text, fontSize: 13, lineHeight: 20 },
});
