# unity-ui-mcp

Turns Claude Design HTML screens into Unity UI Toolkit screens, one to one, and measures the result against the
design. Any MCP-capable AI client (Claude Code, Codex, Cursor, Claude Desktop) drives the loop: lint the design,
import it into the open Unity Editor, verify it, read the report.

**Status:** in development. The design spec is in `docs/specs/`. The Unity package currently contains the Editor
bridge and the `Window → Design UI → Status` window; the exporter, compiler, MCP server and skill are being built.

- `tools/design-export` - Node/TypeScript CLI (`lint`, `export`, `compare`)
- `packages/com.unity.design-ui` - Unity UPM package (Unity 6000.3 or later)
- `samples/FidelityProject` - Unity 6000.3.6f1 test project
- `design-kit` - design kit config, tokens and rules

## Install the Unity package

Package Manager → **+** → *Install package from git URL…*:

```
https://github.com/ErtugrulGaziAKCAN/unity-ui-mcp.git?path=/packages/com.unity.design-ui#m0-m1
```

`m0-m1` is the development branch. Unity pins the commit in `packages-lock.json`; to update, add the URL again or
delete the `com.unity.design-ui` entry from `packages-lock.json`.

## Running Unity checks (maintainers)

Unity verification runs on an isolated copy of the sample project made by the maintainer's local clone tool
(`~/unity-clone-test`, not part of this repository). Because the copy lives outside this repo, use the wrapper,
which temporarily makes the package reference in `samples/FidelityProject/Packages/manifest.json` absolute and
restores it on exit: `scripts/unity-check.sh --warm --editmode "" --assembly DesignUi.Editor.Tests`. When the task
is finished run `scripts/unity-check.sh --done`. Never edit the manifest entry by hand; the wrapper refuses to start
(exit 2) if it is not the relative value.

## Fonts

`samples/FidelityProject/Assets/Fonts/Inter/` contains Inter, licensed under the SIL Open Font License (`OFL.txt`).
