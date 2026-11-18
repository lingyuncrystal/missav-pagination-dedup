# Development and Formal Release Environments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Separate a mobile-testable `dev` userscript from the stable `main` userscript without maintaining duplicate business logic.

**Architecture:** The `dev` branch carries the same source with a distinct userscript identity and GitHub Raw update URL, so it can coexist with the formal script. Formal publishing remains restricted to `main`; `publish-dev.sh` only validates and pushes `dev`, while promotion is a deliberate merge from `dev` to `main` followed by the existing formal release workflow.

**Tech Stack:** Git branches, Tampermonkey/ScriptCat metadata, Bash publish scripts, Node syntax checks, ScriptCat static checks.

---

### Task 1: Add the development userscript identity

**Files:**
- Modify: `missav-enhancer.user.js` metadata header

Use a `-dev` suffix in `@name`, a distinct `@namespace`, and `dev` branch Raw URLs. Keep runtime logic identical to `main`.

### Task 2: Add development publishing automation

**Files:**
- Create: `scripts/publish-dev.sh`

The script must require branch `dev`, run syntax/static checks, require a `4.0.x-dev.N` version, commit and push `dev`, and never create tags or invoke SleazyFork publishing.

### Task 3: Document installation and promotion

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

Document both Raw installation URLs, coexistence behavior, the dev-to-main promotion sequence, and the rule that experiments stay off `main` until confirmed.

### Task 4: Verify both release paths

Run `node --check`, ScriptCat static checks, `bash -n`, `publish-dev.sh --dry-run`, and the existing `publish.sh --dry-run` on the appropriate branches. Confirm `main` remains at the stable formal version and `dev` has the distinct identity.
