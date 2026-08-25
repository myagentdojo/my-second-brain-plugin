# Decision View Source Guidance

- Keep the happy path one-pass and inline. Add no profile, package, runtime,
  repository inspection, external tool, or optional reference lookup.
- Update `scripts/decision-view.test.ts` when the shipped-source contract changes.
