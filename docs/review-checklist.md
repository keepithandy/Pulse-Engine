# Review Checklist

Use this before merging a Pulse Engine change.

- Keep engine primitives reusable and project-agnostic.
- Preserve deterministic state transitions and predictable defaults.
- Avoid coupling engine helpers to one game's content or progression rules.
- Check browser startup from a clean load after changing initialization code.
- Keep dependencies minimal and justified.
- Add a focused smoke case when changing shared state, timing, or rendering helpers.

A safe engine patch should make downstream projects simpler without expanding their required setup.
