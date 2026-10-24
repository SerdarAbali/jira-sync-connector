# Engineering safety invariants and acceptance

These invariants are application requirements, not a declaration that every path
already satisfies them. Status refers to base commit
`538ea4c910b7c053a14f0bc4ed2188cd02e994ff`. This framework changes no runtime behavior.
Packages 2 and 3 remain unresolved and outside this change; passing CI does not
close their defects or authorize release.

## Invariants and evidence

| Area | Required invariant | Existing evidence and remaining boundary |
| --- | --- | --- |
| Authorization and source selection | Only currently authorized source issues may be exported. Check current project authorization and optional JQL at every new write, including both link endpoints, exported hierarchy, recursion, manual/scheduled paths, queue continuations and recovery. Historical mappings grant no authority. Inbound authorization is separate. | Package 1's 134 regressions (21 scope/routing and 113 outbound guarantee tests) exercise production guards with simulated storage/transport. Reuse the [outbound guarantee and path inventory](PACKAGE1_OUTBOUND_SELECTION_GUARANTEE.md) and [completion evidence](PACKAGE1_SCOPE_ROUTING_REVIEW.md). Live permissions and search consistency remain unverified. |
| Write safety | Never blindly retry an uncertain Jira mutation. Persist submission intent before non-idempotent operations where required; retain evidence through recovery. Distinguish a provably unsent/definitively rejected operation from an ambiguous external outcome. Reconcile ambiguity without resubmission until there is sufficient evidence or an explicitly safe recovery decision. | Existing retry, issue/attachment operation and comment submission cases provide bounded evidence (`pilot-write-retry-safety`, `f05-write-recovery`, `attachment-operation`, `f06-comment-submission`). They do not certify all writes or close Package 2/3 work. |
| Concurrency and recovery | Establish ownership using documented conditional storage operations, not a read-then-write assumption. Expired leases never prove a Jira write did not occur. Stale workers must not release, overwrite or invalidate successor ownership or submission evidence. | `f07-issue-lease` and `f06-comment-submission` exercise conditional storage boundaries. The [F07 decision](F07-ISSUE-LEASE-DECISION.md) retains a closed activation gate and separate migration requirements. Local tests do not establish live transaction/error behavior or activation readiness. |
| Synchronization correctness | Do not discard genuine user changes as connector echoes. Denied or deferred operations cannot be recorded as successful or advance the affected success checkpoint. Incomplete pagination cannot imply complete synchronization. | Package 1 tests denial/checkpoint behavior and incomplete source-selection search. Existing sync, reconciliation and initial-sync tests are partial evidence, not application-wide echo or pagination certification. Outstanding Package 2/3 requirements remain pending. |
| Pause and configuration | Pause blocks writes through all relevant paths. Malformed existing safety-control records fail closed. Long-running work respects current authorization and configuration at each new write boundary. | Existing pause suites and Package 1 late-scope/configuration tests cover specific paths. They do not establish universal pause coverage or malformed-control handling; broader unresolved requirements await implementation and regression evidence. |

Test names above refer to files under `tests/` with the `.test.js` suffix.
Expand the existing entry-point inventory when introducing a path; do not duplicate
it here. Fresh authorization checks cannot atomically revoke a request already
submitted: Jira reads, search, Forge storage and destination writes do not share
one transaction. Preserve confirmed historical receipts and unknown outcomes when
selection changes. Do not silently remove destination content after revocation.

## Authoritative platform contracts

Consult the current official documentation and the installed SDK version when
changing a boundary. The application invariants may be stricter than platform APIs.

- [Jira REST authorization and pagination](https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/)
  and [enhanced search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/):
  respect endpoint permissions and pagination contracts; search is eventually
  consistent, and bounded/incomplete reads are not proof of full coverage.
- [Jira rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/):
  retry eligibility depends on idempotency as well as response guidance. A delay
  header alone does not authorize replay of an uncertain non-idempotent mutation.
- [Custom Entity Store transactions](https://developer.atlassian.com/platform/forge/storage-reference/entities-transactions/):
  documented conditional operations provide atomic commit/rollback within storage,
  not a transaction with Jira. Preserve ownership predicates on every transition.
- [KVS methods](https://developer.atlassian.com/platform/forge/storage-reference/kvs-api/)
  and [KVS transactions](https://developer.atlassian.com/platform/forge/storage-reference/kvs-transactions/):
  use the guarantees of the actual operation and installed SDK. TTL cleanup and
  ordinary reads/writes do not supply an ownership fence or remote-write evidence.

## Bounded acceptance process

1. Reproduce a defect or document a requirement with explicit acceptance criteria.
2. Name the affected invariant and enumerate relevant execution paths and boundaries.
3. Add failing regressions against production code; retain the failing result.
4. Implement the smallest safe correction, preserving supported functionality.
5. Independently verify adjacent entry points, negative controls, failures,
   retries and concurrent/delayed execution where relevant. For security changes,
   challenge the contract and assumptions separately from the implementation.
6. Run deterministic CI checks and record results and unavailable verification.
7. Close the task once its defined criteria pass. Record unrelated findings in a
   separate backlog; demonstrated material security/correctness issues affecting
   the current release decision must be escalated as blockers with evidence.

A documented limitation has an explicit scope, impact and follow-up; documenting
a demonstrated release blocker does not resolve it. No deployment, migration,
release or live-data change follows automatically from acceptance.

## Deterministic gates and limits

CI runs full Jest once on every push and pull request, without path filters;
this includes both Package 1 suites and fails on a failed test. For focused local
verification use `npm run test:guarantees`. Full Jest, ESLint, secret scan,
production dependency audits, admin build and offline Forge checks remain intact.
The offline check is client-side static validation, not authenticated Forge lint,
live Jira/Forge validation, or Marketplace certification.

The neutrality gate checks committed Git blobs in CI (`--committed`), all index
blobs before commit (`--staged`), or tracked plus nonignored untracked working
files locally (default). It checks file contents, so `AGENTS.md` is a permitted
filename with no content exemption. Dependencies, lockfiles, generated directories,
minified assets, source maps and binary files are excluded. No authored source,
tests, scripts or documentation have a blanket exemption. Restricted vocabulary
uses token digests; attribution and internal-discussion patterns are also checked.
This is a bounded text check, not semantic proof: independent review must still
catch unlisted names, paraphrased attribution or transcripts. Do not add broad
exclusions or bypass safety tests to obtain a green gate.
