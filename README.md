# AI Shogun

## Codex Sandbox (Landlock) workaround

In some dev containers, Codex may fail to run `shell_command` / `apply_patch` with this error:

```
error running landlock: Sandbox(LandlockRestrict)
```

This is **not a code bug**. It means the Codex sandbox cannot be enabled in this environment.

### Quick fix (recommended in a dev container)

Disable the Codex sandbox for this project by editing your Codex config file:

- Location: `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`)
- Add or change:

```toml
sandbox_mode = "danger-full-access"
```

Then restart Codex / the IDE extension.

### Notes

- `danger-full-access` turns off the sandbox. Use it only in a trusted environment (e.g., inside this dev container).
- If you prefer, you can run Codex on the host (outside the container) instead of disabling the sandbox.

