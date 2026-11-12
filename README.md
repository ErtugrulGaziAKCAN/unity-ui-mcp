# unity-ui-mcp

Turns Claude Design HTML screens into Unity UI Toolkit screens.

- `tools/design-export` - Node/TypeScript CLI (`lint`, `export`, `compare`)
- `packages/com.unity.design-ui` - Unity UPM package
- `samples/FidelityProject` - Unity 6000.3.6f1 test project
- `design-kit` - design kit config, tokens and rules

## Running Unity checks

Unity verification runs on an isolated clone via `~/unity-clone-test`. Because the clone lives outside this repo, use the wrapper, which temporarily makes the package reference in `samples/FidelityProject/Packages/manifest.json` absolute and restores it on exit: `scripts/unity-check.sh --warm --editmode "" --assembly DesignUi.Editor.Tests`. When the task is finished run `scripts/unity-check.sh --done`. Never edit the manifest entry by hand; the wrapper refuses to start (exit 2) if it is not the relative value.
