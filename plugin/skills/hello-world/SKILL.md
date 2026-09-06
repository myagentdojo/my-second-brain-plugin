---
name: hello-world
description: "Run the compiled hello-world app to prove portable plugin distribution on macOS arm64."
---

# Hello World

Resolve the installed plugin root two directories above this `SKILL.md`, then run its `bin/hello-world hello --json` launcher.

Report the JSON result. The launcher selects the plugin's compiled executable on `darwin-arm64`; it includes Bun and needs no runtime setup. If it returns an error envelope, report its cause and rebuild or reinstall guidance. Runtime download cannot repair a compiled payload.
