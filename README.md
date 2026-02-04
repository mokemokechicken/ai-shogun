# AI Shogun

## Quick Start (npx)

```
npx @mokemokechicken/ai-shogun
```

Show CLI options:

```
npx @mokemokechicken/ai-shogun --help
```

## Configuration

Default ports:
- Server: `4090`
- Web: `4091`

Environment variables:
- `SHOGUN_ROOT`: workspace directory (where `.shogun/` is created)
- `SHOGUN_PORT`: server port
- `SHOGUN_WEB_PORT`: web dev server port
- `VITE_API_URL`: web dev proxy target (optional)

## Packaging

Create a distributable package:

```
make package
```

This produces `ai-shogun-<version>.tgz` in the repo root. You can test it locally:

```
npx ./ai-shogun-<version>.tgz
```

Clean build artifacts:

```
make clean
```

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
