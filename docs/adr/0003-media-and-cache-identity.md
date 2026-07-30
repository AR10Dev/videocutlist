# ADR 0003: Media and Cache Identity

Status: accepted

Media identity hashes the configured root alias and normalized relative path.
The cache separately includes size and nanosecond mtime, so replacement
invalidates cached previews without hashing multi-gigabyte originals.
Moves are represented as a missing old item and a new item.

