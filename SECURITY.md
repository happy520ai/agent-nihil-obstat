# Security

ANO handles source code and potentially sensitive session history. This project is still in development; no release is currently published.

## Reporting

Do not open a public issue containing secrets, private transcripts, or exploit details. Until a project security contact is configured, contact the repository owner through a private channel.

## Design boundaries

- No query language or JavaScript expression is accepted by `recall`.
- External command execution uses argv arrays without a shell and records evidence separately from ledger transactions.
- Session artifacts are untrusted input; adapters parse data without evaluating it.
- The host project's TypeScript installation is never loaded by default; this project currently forbids it.
- Release approval, attestation, baseline approval, and synchronization are human CLI actions, not MCP tools.
- Cached databases can be rebuilt. Ledger events are the durable project record.

This document is a development security policy, not a claim that the full implementation or release hardening has completed.
