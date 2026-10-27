/**
 * Default create-path doubles for suites that exercise synchronization but not
 * witness enforcement itself.
 *
 * The real guard and establishment behaviour is covered by
 * `pair-witness-create-guard.test.js`, `pair-witness-establishment.test.js` and
 * `pair-witness-create-enforcement.test.js`. Suites that test unrelated paths
 * mock these two collaborators explicitly rather than weakening production
 * fail-closed behaviour.
 */
const guardModule = {
  PAIR_WITNESS_GUARD_DECISIONS: Object.freeze({ ALLOW: 'allow', BLOCK: 'block' }),
  PAIR_WITNESS_GUARD_CODES: Object.freeze({
    NO_WITNESS_EVIDENCE: 'PAIR_WITNESS_NO_EVIDENCE',
    NOT_APPLICABLE_LEGACY: 'PAIR_WITNESS_NOT_APPLICABLE_LEGACY'
  }),
  evaluatePairWitnessCreateGuard: jest.fn(async () => ({
    decision: 'allow',
    code: 'PAIR_WITNESS_NO_EVIDENCE'
  })),
  syncDecisionForGuardCode: jest.fn(() => 'conflict')
};

const establishmentModule = {
  WITNESS_ESTABLISHMENT_OUTCOMES: Object.freeze({
    APPLIED: 'witness-established',
    ALREADY_PRESENT: 'witness-already-present',
    PARTIAL: 'witness-partial',
    FAILED: 'witness-establishment-failed',
    READ_BACK_FAILED: 'witness-read-back-failed',
    CONFLICT: 'witness-conflict',
    DEFERRED: 'witness-deferred',
    BLOCKED: 'witness-blocked',
    UNAVAILABLE: 'witness-unavailable',
    NOT_APPLICABLE: 'witness-not-applicable',
    MAPPING_PERSISTENCE_FAILED: 'witness-skipped-mapping-failure',
    LEDGER_PERSISTENCE_FAILED: 'witness-skipped-ledger-failure'
  }),
  establishPairWitness: jest.fn(async () => ({
    success: true,
    outcome: 'witness-established'
  })),
  recordWitnessPersistenceFailure: jest.fn(async () => ({
    success: false,
    outcome: 'witness-establishment-failed'
  }))
};

module.exports = { guardModule, establishmentModule };
