---
name: unity-ui-mcp
description: Apply a Claude Design (or other AI-made HTML) design to Unity UI Toolkit with the design-ui MCP tools - lint, import, verify. Use when the user wants to bring a design, canvas or artboard into Unity UI, or says "Claude Design'ı Unity arayüzüne uygula", "tasarımı UI Toolkit'e aktar", "ekranı Unity'ye al", "apply this design to Unity", "import this screen into Unity UI Toolkit".
---

# /unity-ui-mcp

Turns a design (Claude Design canvas, or plain HTML that follows the design contract) into a Unity UI Toolkit screen and
measures the result against the design. You drive it through the `design_ui_*` MCP tools. Work in the order below and
stop where a step says stop.

## 1. Are the tools there?

If this session has no `design_ui_*` tools, the MCP server `design-ui` is not registered for this client (or the
session started before it was). Do not try to work around it. Show the setup for the current client and stop:

- Easiest: ask the user to give you the repository URL and the Unity project folder, then follow `INSTALL.md` in the
  repository (`scripts/setup.sh --project <UnityProjectDir> --client claude-code|codex|cursor|all`, with `--dry-run`
  first).
- By hand, the server command for any client is
  `node <clone>/tools/design-ui-mcp/dist/server.js --project <UnityProjectDir>`.
  Claude Code: `claude mcp add --scope local design-ui -- node <that command>`; Cursor: `.cursor/mcp.json`;
  Codex: `~/.codex/config.toml` (`[mcp_servers.design-ui]`). The README lists the exact snippets.

Tell the user to start a new session after registering, then stop.

## 2. Is Unity connected?

Call `design_ui_list`. It lists the screens under `designRoot` and reports `unity.bridge`.

- `connected`: continue.
- anything else (`not-found`, `not-responding`, `unauthorized`): tell the user to open the project in Unity with the
  `com.unity.design-ui` package installed (`Window > Design UI > Status` shows the bridge) and stop. Lint needs no
  Unity, so linting a design is still possible, but import and verify are not.

Call `design_ui_status` once and read which tools are live in this version. Say honestly which steps are "not
available yet" (a tool that is not available returns an error with the reason). Never replace such a step by hand
(no UXML or USS written yourself, no screenshots standing in for `design_ui_verify`).

## 3. The contract

Call `design_ui_rules` before you write or judge any HTML. It lists the attributes, text styles, fonts, allowed CSS
and lint rules the design must follow.

## 4. Claude Design canvases

If the user gives a claude.ai artifact link of a Design canvas, and this client has an Artifact tool:

1. Read `project/canvas.json` with the Artifact tool and pick the artboard the user named (one artboard is one screen;
   ask if it is unclear).
2. Save the artboard page (`project/<name>.dc.html`) and every `/_blob/<id>` it references into
   `<designRoot>/<screen-id>/`, with a `blobs.json` that maps each blob id to the local file name. Use the artboard
   title as `<screen-id>`.
3. Continue with step 5 for that screen.

If the client has no Artifact tool, ask the user to export or download the canvas into `<designRoot>/<screen-id>/`
and continue from there. Never invent blob files or edit the design to make it pass.

## 5. Per screen

For each screen the user names:

1. `design_ui_lint { design }`. If there are errors, report them as design-side fixes (rule id, element, fix) for the
   user or the design tool to apply, and stop. Do not fix them in Unity output or by editing the exported files.
2. `design_ui_import { design }`. If it answers "not available yet" or fails, report the reason as it is and stop.
3. `design_ui_verify { screen }`. Report the verdict exactly as returned, the report path and the top issues.
4. Use `design_ui_status { screen }` for hashes, last import and last verdict when the user asks what changed.
   `design_ui_kit_sync` refreshes the kit fonts and settings from Unity; run it when the user asks for it or when
   lint reports kit-related findings.

## 6. Rules

- Never edit generated files (the exported IR, goldens, UXML, USS, anything under `<screen>/.design-ui/` or in the
  Unity project that the tools produced). Fix the design and run the tools again.
- Never invent presenters, bindings, game data or behavior. This version produces visuals only.
- Never claim a pass that `design_ui_verify` did not return. If a check did not run, say so.
- Do not change anything in the user's Unity project except through the tools, and never commit or push for the user.

## 7. Publishing the kit to Claude Design

When the user asks to publish the design kit to Claude Design (so designs start with the kit's fonts, tokens and
rules), say that the kit export comes with the kit release as `design-export kit claude`, which writes the kit as a
Claude Design System folder. If that command does not exist in this clone's `design-export`, say it is not available
yet and stop. Do not assemble the design system by hand.
