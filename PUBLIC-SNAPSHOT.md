# Public snapshot notice

This repository is the public, sanitized snapshot of the ANO project.

- Internal project-management state (`.pm/`), local ledgers (`.ano/`) and local agent session data are not published.
- Real project names, personal names, local home paths and host session identifiers were redacted to placeholders.
- Historical acceptance evidence is retained only where it is required to reproduce tests; redaction does not change the underlying implementation.
- Some historical documents still name internal evidence files that are intentionally withheld from this public snapshot. Those references are traceability notes, not downloadable files.
- Test fixtures intentionally contain fake credential-shaped strings (for example AWS-like keys, `password=…`, `api_key=…`) to prove redaction and fail-closed behavior. They are not usable credentials.
- The project is a local alpha. Passing tests or Gate evidence do not constitute production approval; releases and real-project cutovers still require a named human decision.

License: MIT.
