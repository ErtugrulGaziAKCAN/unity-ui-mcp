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

## Capturing a compiled screen

The Unity capture renders a compiled screen the way the design's goldens show it (every job of the export's
`goldens/matrix.json`, filled with `fixtures/sample-data.json`) so that `design-export compare` can judge it. It is
an EditMode test of the package's test assembly, `DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv`:

1. Make the package's tests visible in the consuming project: add `"testables": ["com.unity.design-ui"]` to
   `Packages/manifest.json` (the sample project has it).
2. Run it in batchmode on a copy of the project, never in the open Editor:

   ```
   DESIGN_UI_EXPORT=<export folder> DESIGN_UI_OUT=<capture folder> \
     <Unity> -batchmode -projectPath <project copy> -runTests -testPlatform EditMode \
     -testFilter DesignUi.Editor.Tests.DesignCaptureTests.CaptureFromEnv -testResults <results.xml>
   ```

   - `DESIGN_UI_EXPORT`: the export folder (`screen.ir.json`, `fixtures/sample-data.json`, `goldens/matrix.json`).
   - `DESIGN_UI_OUT`: where the captures go: `<capture>.png` and `boxes.json` named like the goldens, the compiled
     `.design-ui.json` (removed wrappers) and `boxes.meta.json` (what was not captured and why, timings).
   - `DESIGN_UI_SCREEN` (optional): the compiled screen folder; default `<profile output folder>/<Screen>`.
   - `DESIGN_UI_PROFILE` (optional): the DesignUiProfile asset; default the project's only profile.
   - `DESIGN_UI_EXPORT_DIR` and `DESIGN_UI_OUT_DIR` are accepted as well. Without `DESIGN_UI_EXPORT` the test does nothing.
3. `design-export compare <export folder> --unity <capture folder> --report report.html`.

Animation samples are listed in `boxes.meta.json` as not captured until the animation player exists, so a screen
with animations does not pass yet. Maintainers run the capture with `scripts/unity-check.sh --warm --wait --editmode
"CaptureFromEnv"` and the variables above.

## Fonts

`samples/FidelityProject/Assets/Fonts/Inter/` contains Inter, licensed under the SIL Open Font License (`OFL.txt`).
