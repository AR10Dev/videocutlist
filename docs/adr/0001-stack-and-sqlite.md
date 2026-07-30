# ADR 0001: Go/React and SQLite Driver

Status: accepted

Use Go 1.26, standard `net/http`, React/Vite/TypeScript, and SQLite. Use one
CGO-free Go SQLite driver so builds remain reproducible on the target host.
Do not add a web framework or metrics library unless the standard library
becomes measurably insufficient.

