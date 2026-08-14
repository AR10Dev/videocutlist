# Contributing

Thanks for helping improve VideoCutlist.

## Before opening a pull request

1. Keep changes focused and explain the user-visible result.
2. Add or update tests for non-trivial behavior.
3. Run the checks locally:

   ```bash
   make check
   make smoke
   ```

4. Do not commit media originals, previews, exports, caches, databases, secrets,
   or worktrees.
5. Use pnpm and keep `client/pnpm-lock.yaml` synchronized with `client/package.json`.

## Project boundaries

- The service binds to `127.0.0.1` by default.
- Original-media paths must not be accepted from or returned to browsers.
- FFmpeg and FFprobe must be invoked with argument arrays and cancellable
  contexts.
- Publish incomplete cache and export files only through atomic rename.

Please use a clear commit or pull-request title and include relevant test
results. GitHub Actions runs the same repository checks for pull requests.
