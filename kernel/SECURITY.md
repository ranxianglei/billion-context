# Security Policy

## Supported versions

`acp-kernel` is pre-1.0 and releases often. Security fixes land on `master`
and ship in the next npm release. Only the latest published version is
supported.

| Version                         | Supported |
| ------------------------------- | --------- |
| latest `0.0.x` on npm           | ✅        |
| older releases, `pr-*` npm tags | ❌        |

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security
vulnerability.**

Report it privately through GitHub:
[**Security → Report a vulnerability**](https://github.com/ranxianglei/billion-context/security/advisories/new).

Please include:

- the affected version or commit,
- the affected module (e.g. `src/ccr.ts`, `src/wire/openai.ts`),
- a description of the issue and its impact,
- steps or a minimal input to reproduce it, and
- any suggested fix, if you have one.

## What to expect

- An acknowledgement within **7 days**.
- An initial assessment (accepted or declined, with a severity) within
  **14 days**.
- For accepted reports, a fix and a GitHub Security Advisory, with a CVE
  requested where appropriate. Reporters are credited unless they ask not to
  be.

Please give us a reasonable window to release a fix before any public
disclosure. We aim for 90 days or less.

## Scope

`acp-kernel` never calls a model or the network itself, but it processes text
that is not trusted: tool results, model output, and conversation history
supplied by the host. Examples of issues that are **in scope**:

- Untrusted content (tool results, fetched pages, model-written tool
  arguments) being promoted to a more privileged role or channel, such as a
  system or developer message, or escaping its delimiters.
- Denial of service from crafted input, e.g. catastrophic regex backtracking
  or unbounded memory or CPU use in parsing, compression, search, or wire
  encoding.
- Protected-content filtering, message-ref, or block-state logic that can be
  bypassed to hide, alter, or misattribute conversation content.
- Path traversal or unsafe file writes in `acp-kernel/persist`.
- Weaknesses in this repository's CI and release workflows
  (`.github/workflows/`) that could lead to a compromised npm package.

**Out of scope:**

- Model behaviour on its own, such as a model obeying a prompt injection
  that `acp-kernel` delivered at its correct, unprivileged role.
- Vulnerabilities in host adapters (e.g. `pai-acp`) or agent platforms. Please
  report those to their own projects.
- Vulnerabilities in development-only dependencies that do not affect the
  published package.
