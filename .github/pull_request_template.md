<!--
PR template for agentpact. Every merged PR must carry three verifiable
receipts (moneypath gate G8). A ticked box means you ACTUALLY ran the
thing and the evidence is real. If you did not run one, leave it
unchecked and say why — an honest gap beats a fabricated receipt.
-->

## What & why

<!-- One paragraph: what does this change, and what problem does it solve? -->

## Receipts (required for merge — gate G8)

### ocr review

- [ ] I ran `ocr review` on this diff and addressed its findings (paste the
      session link or a short summary of findings below)

<details>
<summary>ocr findings / session</summary>

<!-- ocr session link or findings summary -->

</details>

### ripwire analysis

- [ ] I ran `ripwire` over the touched area and can name what this change
      touches (top-ranked affected symbols, blast radius)

<details>
<summary>ripwire output / analysis</summary>

<!-- e.g. `ripwire apps/api --top-k=30 | head` or the affected-symbol list -->

</details>

### CI proof artifact

- [ ] The **CI proof** workflow ran on this PR head SHA and uploaded the
      `ci-proof` artifact (ci-proof.json: test counts, lint/typecheck
      status, commit SHA, run URL). I checked the artifact's numbers match
      reality (tests actually ran, counts match expectation).

<!-- Paste the run URL and the ci-proof.json test totals: -->

- Run URL:
- Tests: collected=__ passed=__ failed=__ skipped=__

## Testing

- [ ] Full test suite green in CI on this PR
- [ ] New behaviour has a test; bug fixes have a regression test

## Linked issues

<!-- Closes #NNN -->
