import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OLD_PACKAGE_NAME, oldPackageId, packageStamp, PACKAGE_NAME } from "../src/package-stamp.js";
import { tempDir } from "./helpers.js";

function project(): string {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "Packages"), { recursive: true });
  return dir;
}

function writePackage(dir: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

describe("packageStamp", () => {
  it("is null without the package", () => {
    expect(packageStamp(project())).toBeNull();
  });

  it("names a git package by its locked commit and a registry package by its version", () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, "Packages", "manifest.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: "https://example.invalid/repo.git?path=/packages/x#main" } }));
    fs.writeFileSync(path.join(dir, "Packages", "packages-lock.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: { version: "https://example.invalid/repo.git", source: "git", hash: "f2fa501a968f1feaf93a8ef78489ec077d3871cb" } } }));
    expect(packageStamp(dir)).toBe("git:f2fa501a968f1feaf93a8ef78489ec077d3871cb");
    fs.writeFileSync(path.join(dir, "Packages", "packages-lock.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: { version: "0.2.0", source: "registry" } } }));
    expect(packageStamp(dir)).toBe("registry:0.2.0");
  });

  it("hashes a local (file:) or embedded package's files, leaving out tests, hidden and ~ folders", () => {
    const dir = project();
    const pkg = path.join(dir, "..", path.basename(dir) + "-pkg");
    writePackage(pkg, { "package.json": "{}", "Editor/A.cs": "a", "Runtime/B.cs": "b", "Tests/T.cs": "t", "Documentation~/d.md": "d", ".git/x": "x" });
    fs.writeFileSync(path.join(dir, "Packages", "manifest.json"), JSON.stringify({ dependencies: { [PACKAGE_NAME]: `file:../../${path.basename(pkg)}` } }));
    const first = packageStamp(dir);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const rel of ["Tests/T.cs", "Documentation~/d.md", ".git/x"]) fs.writeFileSync(path.join(pkg, rel), "changed");
    expect(packageStamp(dir)).toBe(first);
    fs.writeFileSync(path.join(pkg, "Editor", "A.cs"), "a2");
    const second = packageStamp(dir);
    expect(second).not.toBe(first);
    fs.renameSync(path.join(pkg, "Editor", "A.cs"), path.join(pkg, "Editor", "C.cs"));
    expect(packageStamp(dir)).not.toBe(second);

    const embedded = project();
    writePackage(path.join(embedded, "Packages", PACKAGE_NAME), { "package.json": "{}", "Editor/C.cs": "a2", "Runtime/B.cs": "b" });
    expect(packageStamp(embedded)).toBe(packageStamp(dir));
  });

  it("is the id of the repository's Unity package, in its folder name and its package.json", () => {
    const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages", PACKAGE_NAME, "package.json");
    expect(JSON.parse(fs.readFileSync(pkg, "utf8")).name).toBe(PACKAGE_NAME);
  });

  it("matches the package stamp contract shared with the Unity package", () => {
    const contract = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../contracts/package-stamp.json"), "utf8"));
    const dir = project();
    writePackage(path.join(dir, "Packages", PACKAGE_NAME), contract.files);
    expect(packageStamp(dir)).toBe(contract.stamp);
  });
});

describe("oldPackageId", () => {
  it("names where a project still uses the package id before 0.1.0", () => {
    expect(OLD_PACKAGE_NAME).toBe("com.unity.design-ui");
    const dir = project();
    expect(oldPackageId(dir)).toEqual([]);
    const manifest = path.join(dir, "Packages", "manifest.json");
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: { [PACKAGE_NAME]: "file:../x" }, testables: [PACKAGE_NAME] }));
    expect(oldPackageId(dir)).toEqual([]);
    // a UTF-8 BOM, as Unity and some editors write it
    fs.writeFileSync(manifest, "\uFEFF" + JSON.stringify({ dependencies: { [OLD_PACKAGE_NAME]: "https://example.invalid/r.git?path=/packages/" + OLD_PACKAGE_NAME }, testables: [OLD_PACKAGE_NAME] }));
    expect(oldPackageId(dir)).toEqual(["Packages/manifest.json (dependencies)", "Packages/manifest.json (testables)"]);
    fs.writeFileSync(manifest, JSON.stringify({ dependencies: {} }));
    fs.mkdirSync(path.join(dir, "Packages", OLD_PACKAGE_NAME));
    expect(oldPackageId(dir)).toEqual([`Packages/${OLD_PACKAGE_NAME} (an embedded copy)`]);
  });
});
