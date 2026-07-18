import { describe, expect, it } from 'vitest';
import { generalizeDates } from '../src/dates.js';
import { findNameSpans, scrubNames } from '../src/names.js';
import { redact } from '../src/index.js';
import type { PseudonymMap } from '../src/types.js';

/**
 * Tier-3 leak tests (ADR 0022). The deterministic layers are the guarantee:
 * every seeded identifier in the PCR-style corpus below MUST be caught with no
 * model involved. A failure here is a critical bug, same standing as the
 * Tier-1 leak test.
 */

describe('generalizeDates — all mode', () => {
  it('rewrites every full date format to a year-only placeholder', () => {
    const { text } = generalizeDates(
      'DOB 03/15/1948, admitted 2026-07-17, seen March 15, 1948, discharged 15 Mar 1948, follow-up 7/4/26.',
      'all',
    );
    expect(text).not.toMatch(/03\/15\/1948|2026-07-17|March 15, 1948|15 Mar 1948|7\/4\/26/);
    expect(text).toContain('[DATE-1948]');
    expect(text).toContain('[DATE-2026]');
  });

  it('keeps times, relative references, and bare years', () => {
    const src = 'At 14:32, roughly 3 days ago; she was born in 1948.';
    expect(generalizeDates(src, 'all').text).toBe(src);
  });

  it('handles a yearless date in date context', () => {
    const { text } = generalizeDates('Recheck on 03/15 next visit.', 'all');
    expect(text).toContain('[DATE]');
    expect(text).not.toContain('03/15');
  });

  it('labeled record/policy/incident ids are masked (field report 2026-07-17)', async () => {
    const result = await redact(
      'Policy Number ID: s0103443101. Incident Number: BRNE:2026:3035. Patient Care Report Number: FDSU-EPCR-3829165. Unit 6.8 miles.',
      { tier: 1 },
    );
    expect(result.redacted).not.toMatch(/s0103443101|BRNE:2026:3035|FDSU-EPCR-3829165/);
    expect(result.redacted).toContain('[RECORD_ID_1]');
    expect(result.redacted).toContain('6.8 miles'); // unlabeled numbers untouched
  });

  it('GPS coordinates and address-context ZIPs mask; bare numbers survive (PCR-3)', async () => {
    const r = await redact(
      'Destination GPS Location: 41.564308,-70.622237. ZIP Code: 02540. ' +
        'POCASSET, Barnstable County, 02559. 51 Meetinghouse Ln, Bourne, Massachusetts, 02562. ' +
        'Springfield, IL 62704. Odometer 10250 miles, HR 103, glucose 120.',
      { tier: 1 },
    );
    expect(r.redacted).not.toMatch(/41\.564308|-70\.622237|02540|02559|02562|62704/);
    expect(r.redacted).toContain('[GPS_1]');
    expect(r.redacted).toContain('[ZIP_1]');
    // Bare device numbers untouched.
    expect(r.redacted).toContain('10250 miles');
    expect(r.redacted).toContain('HR 103');
    expect(r.redacted).toContain('glucose 120');
  });

  it('street addresses mask; clinical phrasing survives (PCR-6 field test)', async () => {
    const r = await redact(
      'Incident Address: 218 MAIN STREET, apt 209. Station at 51 Meetinghouse Ln. ' +
        'Destination 43 HIGH ST. Gave 5 mg IV over 2 min; 12 lead obtained; 5x straps.',
      { tier: 1 },
    );
    expect(r.redacted).not.toMatch(/218 MAIN STREET|51 Meetinghouse Ln|43 HIGH ST/);
    expect(r.redacted).toContain('[ADDRESS_1]');
    expect(r.redacted).toContain('5 mg IV');
    expect(r.redacted).toContain('12 lead');
    expect(r.redacted).toContain('5x straps');
  });

  it('crew cert ids and PDF word-splits (PCR-2 field test)', async () => {
    const r = await redact(
      'Eric Audette Paramedic P870331 Cody Craveiro Paramedic P0904221. ' +
        'Revise d Traum a Score noted; Appropr iate res ponse to stimu li. Primary Patient Caregiver- At Scene.',
      { tier: 3 },
      null,
    );
    expect(r.redacted).not.toMatch(/P870331|P0904221|Audette|Craveiro/);
    // Split-word fragments and role labels are NOT masked.
    expect(r.redacted).toContain('Traum a Score');
    expect(r.redacted).toContain('res ponse');
    expect(r.redacted).toContain('Caregiver-');
    expect(r.redacted).toContain('Paramedic');
  });

  it('clinical fractions and vitals are NOT dates (field report 2026-07-17)', () => {
    const src =
      'Pain 7/10, strength 5/5 bilaterally, 2/6 systolic murmur, GCS 15/15, SpO2 94 RA improving 8/10.';
    expect(generalizeDates(src, 'all').text).toBe(src);
  });

  it('marks dates non-restorable (one-way, year preserved in placeholder)', () => {
    const { replacements } = generalizeDates('DOB 03/15/1948.', 'all');
    expect(replacements[0]).toMatchObject({ kind: 'date', restorable: false, placeholder: '[DATE-1948]' });
  });
});

describe('generalizeDates — dob-labeled mode (Tier 2)', () => {
  it('masks only dates anchored to a DOB-ish label', () => {
    const { text } = generalizeDates(
      'DOB: 03/15/1948. Incident on 07/17/2026 at the scene.',
      'dob-labeled',
    );
    expect(text).toContain('[DATE-1948]');
    expect(text).toContain('07/17/2026'); // unlabeled incident date survives at Tier 2
  });

  it('recognizes label variants', () => {
    for (const label of ['DOB', 'D.O.B.', 'date of birth', 'birthdate', 'born on']) {
      const { text } = generalizeDates(`${label} 03/15/1948`, 'dob-labeled');
      expect(text, label).toContain('[DATE-1948]');
    }
  });
});

describe('deterministic name scrubbing', () => {
  it('catches the exact production miss: a patient name in a cap run', () => {
    const spans = findNameSpans('Review this PCR: Donna Hitchcock, a 77-year-old female.');
    expect(spans.map((s) => s.original)).toContain('Donna Hitchcock');
  });

  it('a solo ENGLISH-WORD surname is a documented NER-net residual; off-English solos still mask', () => {
    // Policy (field report 2026-07-17): "hitchcock" is in the English list, so
    // alone mid-sentence it no longer solo-triggers — English-word surnames
    // solo-matched every Title-Case form header ("Ems", "Alcohol", "Glasgow").
    // It still masks in pairs ("Donna Hitchcock"), anchored ("Mr Hitchcock"),
    // and comma format ("Hitchcock, Donna").
    expect(findNameSpans('The report mentions Hitchcock repeatedly.')).toHaveLength(0);
    expect(findNameSpans('Mr Hitchcock was seen.').map((s) => s.original)).toContain('Hitchcock');
    // Off-English surnames keep full solo power.
    expect(findNameSpans('The report mentions Natarajan repeatedly.').map((s) => s.original)).toContain('Natarajan');
  });

  it('masks a sentence-initial first name (outside the top-2000 veto)', () => {
    const spans = findNameSpans('Donna is complaining of chest pain.');
    expect(spans.map((s) => s.original)).toContain('Donna');
  });

  it('keeps grammatical "Will you…" / "May I…" via the tiny veto', () => {
    expect(findNameSpans('Will you review this chart?')).toHaveLength(0);
    expect(findNameSpans('May I ask a question?')).toHaveLength(0);
  });

  it('label anchor catches an off-list name', () => {
    const spans = findNameSpans('Patient: Xzavier Qwertyson, seen at 14:00.');
    expect(spans.map((s) => s.original).join(' ')).toContain('Xzavier');
  });

  it('leaves clinical headers alone (no name-list token in the run)', () => {
    const text = 'Chief Complaint: chest pain. Blood Pressure stable. Vital Signs recorded.';
    const spans = findNameSpans(text);
    expect(spans.filter((s) => /Chief|Complaint|Blood|Pressure|Vital|Signs/.test(s.original))).toHaveLength(0);
  });

  it('masks a lowercase off-English name ("cabral"), leaves common words ("young")', () => {
    expect(findNameSpans('spoke with cabral about the lease').map((s) => s.original)).toContain('cabral');
    expect(findNameSpans('the young patient was stable')).toHaveLength(0);
  });

  it('never re-examines existing placeholders', () => {
    expect(findNameSpans('Person-1 was seen on [DATE-1948] per [EMAIL_1].')).toHaveLength(0);
  });

  it('reuses the shared pseudonym map for consistent Person-N numbering', () => {
    const pseudonyms: PseudonymMap = { 'bob henderson': 'Person-1' };
    const { text } = scrubNames('Bob Henderson met Donna Hitchcock.', pseudonyms);
    expect(text).toBe('Person-1 met Person-2.');
    expect(pseudonyms['donna hitchcock']).toBe('Person-2');
  });

  it('same name → same placeholder across calls', () => {
    const pseudonyms: PseudonymMap = {};
    const a = scrubNames('Donna Hitchcock arrived.', pseudonyms);
    const b = scrubNames('Donna Hitchcock left.', pseudonyms);
    expect(a.text).toContain('Person-1');
    expect(b.text).toContain('Person-1');
  });
});

describe('redact() tier orchestration', () => {
  it('tier-3 degraded keeps tierApplied 3 (deterministic IS the guarantee)', async () => {
    const r = await redact('Donna Hitchcock, DOB 03/15/1948.', { tier: 3 }, null);
    expect(r.tierApplied).toBe(3);
    expect(r.tier2Degraded).toBe(true);
    expect(r.redacted).not.toMatch(/Donna|Hitchcock/);
  });

  it('replay-only mode never calls the model and still replays known names', async () => {
    let calls = 0;
    const countingOllama = {
      available: async () => { calls += 1; return true; },
      generateJson: async () => { calls += 1; return '{"entities":[]}'; },
    } as never;
    const r = await redact(
      'Donna Hitchcock said hello to Zyler.',
      { tier: 3, pseudonyms: { 'donna hitchcock': 'Person-1' }, nerMode: 'replay-only' },
      countingOllama,
    );
    expect(calls).toBe(0); // the 3B model is never touched for history
    expect(r.redacted).toContain('Person-1');
    expect(r.tier2Degraded).toBe(false); // nothing failed; NER was not requested
  });

  it('tier 3 with no local model: degraded flag set, deterministic layers still applied', async () => {
    const result = await redact(
      'Patient: Donna Hitchcock, DOB 03/15/1948, SSN 123-45-6789.',
      { tier: 3 },
      null, // no Ollama
    );
    expect(result.tier2Degraded).toBe(true);
    expect(result.redacted).not.toMatch(/Donna|Hitchcock|03\/15\/1948|123-45-6789/);
    expect(result.redacted).toContain('[DATE-1948]');
    expect(result.redacted).toContain('[SSN_1]');
    expect(result.redacted).toMatch(/Person-\d/);
  });

  it('tier 2 with no local model: DOB-labeled date still masked deterministically', async () => {
    const result = await redact('DOB: 03/15/1948, incident 07/17/2026.', { tier: 2 }, null);
    expect(result.redacted).toContain('[DATE-1948]');
    expect(result.redacted).toContain('07/17/2026');
    expect(result.tier2Degraded).toBe(true);
  });

  it('tier 1 is untouched by the new layers', async () => {
    const result = await redact('Donna Hitchcock, DOB 03/15/1948.', { tier: 1 });
    expect(result.redacted).toContain('Donna Hitchcock'); // names are a tier ≥2 concern
    expect(result.redacted).toContain('03/15/1948');
  });
});

describe('adversarial regressions (attack report 2026-07-17)', () => {
  it('ALL-CAPS names are caught — the PCR house style', async () => {
    const result = await redact(
      'NARRATIVE: PT DONNA HITCHCOCK, 77 Y/O FEMALE, DOB 03/15/1948, FOUND BY DAUGHTER SUSAN HITCHCOCK.',
      { tier: 3 },
      null,
    );
    expect(result.redacted).not.toMatch(/DONNA|HITCHCOCK|SUSAN/);
    expect(result.redacted).toContain('[DATE-1948]');
  });

  it('ALL-CAPS clinical acronyms are never masked', () => {
    const text = 'ALS INTERCEPT REQUESTED. EMS ON SCENE. CPR IN PROGRESS. BP 92/60.';
    expect(findNameSpans(text)).toHaveLength(0);
  });

  it('possessives mask the base name and keep the ’s', () => {
    const { text } = scrubNames("Per Donna's daughter, patient was confused.", {});
    expect(text).toContain("Person-1's");
    expect(text).not.toContain('Donna');
  });

  it('hyphenated, Mc/Mac, apostrophe, and accented surnames are caught cleanly', () => {
    for (const [input, mustHide] of [
      ['Smith-Jones arrived by ambulance.', 'Smith-Jones'],
      ['Jean-Pierre Dubois was the caller.', 'Jean-Pierre'],
      ['McDonald complained of chest pain.', 'McDonald'],
      ["O'Brien refused transport.", "O'Brien"],
      ['José García signed the refusal.', 'García'],
    ] as const) {
      const { text } = scrubNames(input, {});
      expect(text, input).not.toContain(mustHide);
      // No corrupted fragments (the José→"Person-1é" bug).
      expect(text, input).not.toMatch(/Person-\d+[a-zà-öø-ÿé]/);
    }
  });

  it('anchors work in ALL-CAPS narratives without eating ordinary words', () => {
    const spans = findNameSpans('PT ZYLER QUANDRIL FOUND SUPINE. PT COMPLAINED OF PAIN.');
    const flat = spans.map((s) => s.original).join(' ');
    expect(flat).toContain('ZYLER');
    expect(flat).not.toContain('COMPLAINED');
  });

  it('ISO datetimes and day-first dates are masked', () => {
    const { text } = generalizeDates(
      'Exported 1948-03-15T14:32:00Z. DOB 15/03/1948; discharged 25.12.1999; seen 15th of March, 1948.',
      'all',
    );
    expect(text).not.toMatch(/1948-03-15|15\/03\/1948|25\.12\.1999|15th of March, 1948/);
    expect(text).toContain('[DATE-1948]');
    expect(text).toContain('[DATE-1999]');
  });
});

describe('adversarial regressions, round 2 (caps machinery + rank-blocked pairs)', () => {
  it('N1: punctuated ALL-CAPS names are caught', () => {
    for (const [input, name] of [
      ['MR SMITH-JONES STABLE', 'SMITH-JONES'],
      ["MR O'BRIEN STABLE", "O'BRIEN"],
      ['DONNA SMITH-JONES FOUND SUPINE', 'SMITH-JONES'],
    ] as const) {
      const flat = findNameSpans(input).map((s) => s.original).join(' ');
      expect(flat, input).toContain(name);
    }
  });

  it('N2: anchored ALL-CAPS common surnames are caught, ordinary words are not', () => {
    expect(findNameSpans('MR SMITH IS AOX4.').map((s) => s.original).join(' ')).toContain('SMITH');
    expect(findNameSpans('DR BROWN NOTIFIED.').map((s) => s.original).join(' ')).toContain('BROWN');
    const lastFirst = findNameSpans('PATIENT: SMITH, JOHN').map((s) => s.original).join(' ');
    expect(lastFirst).toContain('SMITH');
    expect(lastFirst).toContain('JOHN');
    expect(findNameSpans('PT COMPLAINED OF PAIN.')).toHaveLength(0);
  });

  it('N3: a caps run needs only one evidence token (or the pair signature)', () => {
    const a = findNameSpans('DONNA SMITH FOUND SUPINE').map((s) => s.original).join(' ');
    expect(a).toContain('DONNA SMITH');
    const b = findNameSpans('JOHN SMITH FOUND UNRESPONSIVE').map((s) => s.original).join(' ');
    expect(b).toContain('JOHN SMITH');
  });

  it('N4: rank-blocked FIRST→SUR pairs are names in any casing', async () => {
    for (const input of ['John Smith arrived on scene.', 'David Brown c/o chest pain.']) {
      const result = await redact(input, { tier: 3 }, null);
      expect(result.redacted, input).not.toMatch(/John|Smith|David|Brown/);
    }
    // …while surname-only header pairs never fire.
    expect(findNameSpans('Vital Signs recorded. Chief Complaint: pain.')).toHaveLength(0);
    expect(findNameSpans('VITAL SIGNS: BP 92/60. CHIEF COMPLAINT: CP.')).toHaveLength(0);
  });

  it('N5: anchor works with no space after the colon', () => {
    const flat = findNameSpans('Patient:Zyler Quandril, 44yo.').map((s) => s.original).join(' ');
    expect(flat).toContain('Zyler');
  });

  it('pathologies: DOB label, 77YO, AOX3, and ER are never masked', async () => {
    const result = await redact(
      'PATIENT: DONNA HITCHCOCK DOB: 03/15/1948. 77YO F, PT AOX3, TRANSPORTED TO ER.',
      { tier: 3 },
      null,
    );
    expect(result.redacted).toContain('DOB');
    expect(result.redacted).toContain('77YO');
    expect(result.redacted).toContain('AOX3');
    expect(result.redacted).toContain('ER');
    expect(result.redacted).not.toMatch(/DONNA|HITCHCOCK|03\/15\/1948/);
  });
});

describe('redactDeterministic (mobile mirror — no model, never degrades)', () => {
  it('masks names, dates, and secrets across the whole prompt with no NER', async () => {
    const { redactDeterministic } = await import('../src/index.js');
    const result = await redactDeterministic(
      'PATIENT: DONNA HITCHCOCK DOB: 03/15/1948. CONTACT SMITH, JOHN 508-555-0142.',
      { pseudonyms: {} },
    );
    expect(result.redacted).not.toMatch(/DONNA|HITCHCOCK|03\/15\/1948|SMITH|JOHN|508-555-0142/);
    expect(result.tier2Degraded).toBe(false); // nothing promised, nothing degraded
    expect(result.tierApplied).toBe(1); // honest label: bonus on top of Tier 1
  });

  it('shares the pseudonym map so Person-N is stable across turns', async () => {
    const { redactDeterministic } = await import('../src/index.js');
    const pseudonyms = {};
    const a = await redactDeterministic('Donna Hitchcock is here.', { pseudonyms });
    const b = await redactDeterministic('Donna Hitchcock left.', { pseudonyms });
    expect(a.redacted).toContain('Person-1');
    expect(b.redacted).toContain('Person-1');
  });
});

describe('adversarial regressions, round 3 (overlap merge, pairs, anchor noise)', () => {
  it('R1: a 4-token anchored caps name masks completely (overlap merge)', async () => {
    const result = await redact('PATIENT: MARIA GARCIA LOPEZ HERNANDEZ FOUND SUPINE.', { tier: 3 }, null);
    expect(result.redacted).not.toMatch(/MARIA|GARCIA|LOPEZ|HERNANDEZ/);
    const result2 = await redact('PATIENT: SMITH JONES BROWN DAVIS, 77YO.', { tier: 3 }, null);
    expect(result2.redacted).not.toMatch(/SMITH|JONES|BROWN|DAVIS/);
  });

  it('R2: face-sheet "LAST, FIRST" masks in both casings, even rank-blocked', async () => {
    const caps = await redact('SMITH, JOHN DOB 03/15/1948, TRANSPORTED PRIORITY 1.', { tier: 3 }, null);
    expect(caps.redacted).not.toMatch(/SMITH|JOHN/);
    const title = await redact('Smith, John was seen at 14:32.', { tier: 3 }, null);
    expect(title.redacted).not.toMatch(/Smith|John/);
    expect(title.redacted).toContain('14:32');
  });

  it('R3: mixed-casing "John SMITH" masks as one name', async () => {
    const result = await redact('John SMITH found supine, DOB 03/15/1948.', { tier: 3 }, null);
    expect(result.redacted).not.toMatch(/John|SMITH/);
  });

  it('anchor noise: common caps narrative words are not masked after PT/MR', () => {
    for (const input of [
      'PT WAS TRANSPORTED TO ER.',
      'PT MAY HAVE FALLEN.',
      'PT ABLE TO AMBULATE.',
      'PT ON FLOOR.',
    ]) {
      expect(findNameSpans(input), input).toHaveLength(0);
    }
    // …while anchored real names still mask at any rank.
    expect(findNameSpans('PATIENT: JOHN SMITH').map((s) => s.original).join(' ')).toContain('JOHN');
  });

  it('possessive tail no longer glues the possessed object into the span', () => {
    const flat = findNameSpans("SMITH-JONES'S CHART REVIEWED.").map((s) => s.original).join(' ');
    expect(flat).toContain('SMITH-JONES');
    expect(flat).not.toContain('CHART');
  });
});

describe('structured ePCR field report (2026-07-17 over-masking)', () => {
  it('Title-Case form headers produce ZERO deterministic spans', () => {
    for (const header of [
      'First Due Ems Care Report',
      'Care Report Number',
      'Glasgow Score Temp',
      'History Alcohol Drugs',
      'Situation Symptom Onset',
      'Method Eye Verbal Motor Qualifier Total',
      'Billing Primary Method',
      'Reason For Signing',
      'Destination Odometer Reading',
      'Certification State License',
      'Organ System',
      'Signature Reason',
      'Completing This Report',
    ]) {
      expect(findNameSpans(header), header).toHaveLength(0);
    }
  });

  it('real names embedded in the same form still mask', () => {
    const flat = (t: string) => findNameSpans(t).map((s) => s.original).join(' ');
    expect(flat('Last Name Hitchcock Gender F First Name Donna')).toContain('Hitchcock');
    expect(flat('Hitchcock, Donna Company Address')).toContain('Hitchcock, Donna');
    expect(flat('Eric Audette Paramedic P')).toContain('Eric Audette');
    expect(flat('Cody Craveiro Paramedic P')).toContain('Cody Craveiro');
  });

  it('NER junk gate: placeholders, field labels, hex ids, and adjectives are refused', async () => {
    const junkOllama = {
      available: async () => true,
      generateJson: async () =>
        JSON.stringify({
          entities: [
            { text: 'Sex', kind: 'person' },
            { text: 'Date', kind: 'person' },
            { text: 'Arrived', kind: 'person' },
            { text: 'vile', kind: 'person' },
            { text: '8ca72b71', kind: 'person' },
            { text: 'Person-1', kind: 'person' },
            { text: 'Org-1', kind: 'org' },
            { text: 'Zyler Quandril', kind: 'person' },
            { text: 'Barnstable County', kind: 'location' },
          ],
        }),
    } as never;
    const { redact: redactFn } = await import('../src/index.js');
    // Tier 3: the STRICT gate applies (deterministic layers own common names;
    // NER is residuals-only). "vile"/"date"/"sul" are census surnames, so the
    // list-membership arm alone would re-admit them — strict requires
    // off-English tokens.
    const result = await redactFn(
      'Sex F Date noted. Arrived vile 8ca72b71 Person-1 Org-1. Zyler Quandril of Barnstable County.',
      { tier: 3 },
      junkOllama,
    );
    // Only the plausible entities were masked.
    expect(result.redacted).toContain('Sex');
    expect(result.redacted).toContain('Date');
    expect(result.redacted).toContain('Arrived');
    expect(result.redacted).toContain('vile');
    expect(result.redacted).toContain('8ca72b71');
    expect(result.redacted).toContain('Person-1'); // placeholder NOT re-masked
    expect(result.redacted).toContain('Org-1');
    expect(result.redacted).not.toContain('Zyler');
    expect(result.redacted).not.toContain('Barnstable');
  });
});

/**
 * Seeded PCR-style corpus: every seeded patient identifier must be gone after
 * the DETERMINISTIC layers alone (no model). Invented people only.
 */
describe('PCR corpus leak test (deterministic layers only)', () => {
  const CASES: Array<{ doc: string; mustMask: string[] }> = [
    {
      doc:
        'Patient: Donna Hitchcock DOB: 03/15/1948. 77yo F c/o painless vision loss. ' +
        'Hx: macular degeneration. Contact daughter Susan Hitchcock 508-555-0142.',
      mustMask: ['Donna Hitchcock', '03/15/1948', 'Susan Hitchcock', '508-555-0142'],
    },
    {
      doc:
        'Pt. Marcus Delacruz, born 07/04/1951, found unresponsive. ' +
        'Wife Gloria Delacruz on scene. Transported priority 1.',
      mustMask: ['Marcus Delacruz', '07/04/1951', 'Gloria Delacruz'],
    },
    {
      doc:
        'Name: Beatrice Okafor. Date of birth 1962-11-30. Chief Complaint: syncope. ' +
        'PMH per son Daniel Okafor. Vital Signs: BP 92/60, HR 118 at 14:32.',
      mustMask: ['Beatrice Okafor', '1962-11-30', 'Daniel Okafor'],
    },
    {
      doc:
        'Crew contacted resident Willa Vanderberg (DOB March 3, 1940) at the facility. ' +
        'RN Priya Natarajan gave report. Last seen normal 3 hours ago.',
      mustMask: ['Willa Vanderberg', 'March 3, 1940', 'Priya Natarajan'],
    },
  ];

  it('zero seeded identifiers survive the deterministic layers', async () => {
    for (const { doc, mustMask } of CASES) {
      const result = await redact(doc, { tier: 3 }, null); // null = NO model; determinism only
      for (const identifier of mustMask) {
        expect(result.redacted, `leaked "${identifier}" from: ${doc.slice(0, 60)}…`).not.toContain(
          identifier,
        );
      }
    }
  });

  it('clinical utility survives: headers, vitals, and times remain', async () => {
    const result = await redact(CASES[2]!.doc, { tier: 3 }, null);
    expect(result.redacted).toContain('Chief Complaint');
    expect(result.redacted).toContain('BP 92/60');
    expect(result.redacted).toContain('14:32');
  });
});
