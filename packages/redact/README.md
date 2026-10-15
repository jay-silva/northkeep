# @northkeep/redact

On-device redaction applied before content leaves the machine. Tier 1 masks
secrets deterministically and always runs; Tier 2 adds name pseudonymization
through a local Ollama model and reports when it is unavailable; Tier 3 adds
date generalization and dictionary name scrubbing. Redaction sessions give
each masked value a run-scoped token so replies can be restored.
`test/leak.test.ts` is the CI leak gate.
