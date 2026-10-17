# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-17

### Added
- `hss fix`: automatically repair certificate chain order (leaf → intermediate → root) and normalise profile certificate encoding to base64url.
- Backups (`.bak-<timestamp>`) for every rewritten file; `--dry-run` and `--no-backup` flags; idempotent.
- Post-fix verification: re-runs the full check suite and reports the result.
- Regression tests covering real-world edge cases (unlinked certificates, signed p7b profiles).

### Changed
- `profile.cert-encoding` is now informational (`skip`) for signed `.p7b` profiles: AGC-issued profiles embed PEM certificates that `hap-sign-tool` accepts, and a signed profile cannot be rewritten anyway.

### Fixed
- `pemFromBase64Certificate` now restores base64 padding, so unpadded base64url certificates in profiles can be parsed again.

## [0.2.0] - 2026-10-17

### Added
- `hss keygen`: build a complete local signing environment in one command (root CA → intermediate CA → app key/cert chain → profile key/cert chain → profile template).
- Automatic base64url profile template generation, `hss.config.yaml` patching (with backup) and `.gitignore` hardening.
- `--password`, `HSS_KEYGEN_PASSWORD`, random password fallback; `--dry-run`, `--json`, `--force`, `--validity`, `--org`, `--type`.

### Fixed
- Missing `-issuer` on `generate-app-cert` / `generate-profile-cert`.
- Output directory is created before invoking `hap-sign-tool`.

## [0.1.0] - 2026-10-17

### Added
- CLI: `init`, `doctor`, `check`, `sign`, `verify`.
- 20+ pre-flight checks: certificate chain order, key/algorithm match, expiry, bundle name consistency across HAP/config/profile, profile certificate public-key match, profile validity, `.gitignore` hygiene.
- One-command signing pipeline (`sign-profile` + `sign-app` + `verify-app`) with redacted command logging.
- `hss-sign-manifest.json`: input/output SHA-256, commands, durations, check summary — no plaintext secrets.
- Terminal, Markdown and JSON reports.
- GitHub Actions and Gitee-friendly CI template generation.
- Secret references (`{ env: NAME }` / `{ file: path }`) and end-to-end redaction.
