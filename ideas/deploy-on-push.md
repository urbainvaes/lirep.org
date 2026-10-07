# Deployment automation

## Status

Not started. Keep the current manual deployment as a fallback.

## Requirements

- Trigger a release only after the primary branch is updated.
- Keep deployment credentials and machine-specific paths outside the repository.
- Build before restarting, verify health afterwards, and preserve the running
  version if the build fails.
- Run long builds asynchronously so a push does not wait for deployment to
  finish; retain useful, non-sensitive logs.

## Open questions

- How should a failed release roll back to the previous version?
- How should failures be reported?
- Should the application run under a supervised service rather than a terminal
  multiplexer?
