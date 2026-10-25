# Security policy

mergechaos runs git commands on repositories you point it at. It never sends data anywhere: there is no network access in the code.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Include the version, the command you ran and what happened. You should get an answer within a week.

## Scope

In scope: anything that makes mergechaos write to a working tree, index or ref it should not touch, leak file contents it promised to leave out (private files, secrets), or execute code from the repositories it reads.

The secret detection in this tool is a safety net with a short list of patterns, not a scanner. Keep using a dedicated secret scanner in CI.
