import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, ErrorNote, WarningBanner, colors } from '../src/ui';
import { runOnDeviceNerEval, type OnDeviceNerEval } from '../src/lib/local-eval';

/**
 * On-device Tier-2 NER eval (M6-4 GATE, ADR 0023). Runs the seeded corpus
 * through the phone's own model and shows strict recall. This is what decides
 * parity -> ship / near -> "beta" / poor -> private-chat-only. Numbers are
 * produced on THIS device; there is no baked-in result.
 */

const PARITY = 0.85; // desktop Tier-2 target (KNOWN-LIMITS: 85-95% in-domain)

export default function ModelEval() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnDeviceNerEval | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      setResult(await runOnDeviceNerEval((done, total) => setProgress({ done, total })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The evaluation failed.');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>On-device Tier-2 eval</Text>
      <Text style={styles.body}>
        Runs the seeded entity corpus through this phone's model and measures how many
        names, orgs, and places it catches, plus proof the Tier-1 secret floor still holds.
        This decides whether Tier-2 can run on the phone.
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
              ? `Document ${progress.done} of ${progress.total} scored`
              : 'Warming up the on-device model...'}
          </Text>
        </View>
      ) : null}
      <ErrorNote message={error} />

      {result?.status === 'unavailable' ? (
        <WarningBanner
          message={`No on-device model available, so Tier-2 cannot run here. ${result.reason}. Tier-1 stays the guaranteed floor.`}
        />
      ) : null}

      {result?.status === 'ok' ? <Report result={result} /> : null}
    </ScrollView>
  );
}

function Report({ result }: { result: Extract<OnDeviceNerEval, { status: 'ok' }> }) {
  const { report } = result;
  const recallPct = (report.entities.recall * 100).toFixed(1);
  const verdict =
    report.tier1Leaks.length > 0
      ? { label: 'FAIL: Tier-1 leak', color: colors.danger }
      : report.entities.recall >= PARITY
        ? { label: 'Parity: ship Tier-2', color: colors.accent }
        : report.entities.recall >= PARITY - 0.15
          ? { label: 'Near: ship as beta', color: colors.warnText }
          : { label: 'Poor: private-chat only', color: colors.warnText };

  return (
    <View style={styles.report}>
      <Text style={styles.backend}>
        {result.label} ({result.backend})
      </Text>
      <View style={styles.headline}>
        <Text style={styles.recall}>{recallPct}%</Text>
        <Text style={styles.recallLabel}>strict recall (whole span + correct kind)</Text>
      </View>
      <Text style={[styles.verdict, { color: verdict.color }]}>{verdict.label}</Text>

      <Row label="Entities caught" value={`${report.entities.caught} / ${report.entities.total}`} />
      <Row label="Span recall (any kind)" value={`${(report.spanRecall * 100).toFixed(1)}%`} />
      {(['person', 'org', 'location'] as const).map((k) => (
        <Row
          key={k}
          label={`  ${k}`}
          value={`${(report.byKind[k].recall * 100).toFixed(0)}%  (${report.byKind[k].caught}/${report.byKind[k].total})`}
        />
      ))}
      <Row
        label="Tier-1 floor"
        value={report.tier1Leaks.length === 0 ? `held (${report.tier1SecretsChecked} secrets)` : `LEAKED ${report.tier1Leaks.length}`}
      />
      <Row label="Cases" value={`${report.cases}`} />

      {report.misses.length > 0 ? (
        <View style={styles.misses}>
          <Text style={styles.missesTitle}>Misses</Text>
          {report.misses.slice(0, 20).map((m, i) => (
            <Text key={i} style={styles.missLine}>
              {m.text} ({m.kind}){m.detectedAnyKind ? ' - wrong kind' : ' - not detected'}
            </Text>
          ))}
        </View>
      ) : null}
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
  backend: { color: colors.muted, fontSize: 13, fontWeight: '600', marginBottom: 12 },
  headline: { alignItems: 'center', marginBottom: 8 },
  recall: { color: colors.text, fontSize: 44, fontWeight: '800' },
  recallLabel: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  verdict: { fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowLabel: { color: colors.muted, fontSize: 14 },
  rowValue: { color: colors.text, fontSize: 14, fontWeight: '600' },
  misses: { marginTop: 16 },
  missesTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 6 },
  missLine: { color: colors.text, fontSize: 13, lineHeight: 20 },
});
