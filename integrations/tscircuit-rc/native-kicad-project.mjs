import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertRcSourceMapping, findFormEnd } from "./kicad-consistency.mjs";
import { parseDesignSource } from "./design-contract.mjs";
import { workspaceRelativePath } from "./workspace-path.mjs";

export const NATIVE_KICAD_FILES = [
  "rc_filter.kicad_pro",
  "rc_filter.kicad_sch",
  "rc_filter.kicad_pcb",
  "sym-lib-table",
  "fp-lib-table",
];

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

async function assertOutputTargetsAreReplaceable(outputDir) {
  for (const filename of NATIVE_KICAD_FILES) {
    const target = path.join(outputDir, filename);
    try {
      const targetInfo = await lstat(target);
      assert.equal(targetInfo.isDirectory(), false, "Generated KiCad file target must not be a directory: " + target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function publishGeneratedFile(outputDir, filename, contents) {
  const target = path.join(outputDir, filename);
  const temporary = path.join(outputDir, "." + filename + "." + randomUUID() + ".tmp");
  await writeFile(temporary, contents, { flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"]).has(error.code)) throw error;
    const targetInfo = await lstat(target).catch((statError) => {
      if (statError.code === "ENOENT") return null;
      throw statError;
    });
    if (targetInfo) {
      assert.equal(targetInfo.isDirectory(), false, "Generated KiCad file target must not be a directory: " + target);
      await unlink(target);
    }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((cleanupError) => {
      if (cleanupError.code !== "ENOENT") throw cleanupError;
    });
  }
}

function skipQuotedString(text, start) {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === '"') {
      return index + 1;
    }
  }
  throw new Error("Unbalanced quoted string in KiCad S-expression");
}

function directForms(form) {
  const forms = [];
  let cursor = 1;
  while (cursor < form.length - 1) {
    const character = form[cursor];
    if (character === '"') {
      cursor = skipQuotedString(form, cursor);
    } else if (character === "(") {
      const end = findFormEnd(form, cursor);
      forms.push({ start: cursor, end, text: form.slice(cursor, end) });
      cursor = end;
    } else {
      cursor += 1;
    }
  }
  return forms;
}

function rootForms(text, expectedRootName) {
  const rootStart = text.indexOf("(");
  assert.notEqual(rootStart, -1, "KiCad file has no root S-expression");
  const rootEnd = findFormEnd(text, rootStart);
  const root = text.slice(rootStart, rootEnd);
  const rootName = /^\(\s*([^\s()]+)/.exec(root)?.[1];
  assert.equal(rootName, expectedRootName, "KiCad template has an unexpected root form");
  return directForms(root).map((form) => ({
    ...form,
    start: form.start + rootStart,
    end: form.end + rootStart,
  }));
}

function parseProperty(form) {
  const match = /^\(property\s+("(?:\\.|[^"\\])*")\s+("(?:\\.|[^"\\])*")/s.exec(form.text);
  if (!match) return null;
  const valueInMatch = match[0].lastIndexOf(match[2]);
  return {
    name: JSON.parse(match[1]),
    value: JSON.parse(match[2]),
    valueStart: form.start + valueInMatch,
    valueLength: match[2].length,
  };
}

function replaceComponentValues(text, rootName, componentForm, values) {
  const patches = [];
  const found = new Map();
  const expectedReferences = new Set(Object.keys(values));
  const rootChildren = rootForms(text, rootName);
  const formPattern = new RegExp("^\\(" + componentForm + "(?=\\s|\\))");

  for (const component of rootChildren) {
    if (!formPattern.test(component.text)) continue;
    const properties = directForms(component.text)
      .map(parseProperty)
      .filter(Boolean);
    const references = properties.filter((property) => property.name === "Reference");
    const reference = references[0]?.value;
    if (!expectedReferences.has(reference)) continue;

    assert.equal(references.length, 1, componentForm + " must have exactly one Reference property for " + reference);
    assert.equal(found.has(reference), false, "KiCad template contains duplicate component " + reference);
    const valueProperties = properties.filter((property) => property.name === "Value");
    assert.equal(valueProperties.length, 1, "KiCad " + reference + " must have exactly one Value property");
    found.set(reference, true);
    patches.push({
      start: component.start + valueProperties[0].valueStart,
      end: component.start + valueProperties[0].valueStart + valueProperties[0].valueLength,
      replacement: JSON.stringify(values[reference]),
    });
  }

  for (const reference of expectedReferences) {
    assert.equal(found.has(reference), true, "KiCad template is missing " + reference + " in its " + rootName);
  }

  let updated = text;
  for (const patch of patches.sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, patch.start) + patch.replacement + updated.slice(patch.end);
  }
  return updated;
}

export async function buildNativeKicadProject({ workspaceRoot, templateDir, outputDir, design, sourceManifest }) {
  assert.ok(typeof workspaceRoot === "string" && workspaceRoot.length > 0, "KiCad workspace root is required");
  assert.ok(typeof templateDir === "string" && templateDir.length > 0, "KiCad template directory is required");
  assert.ok(typeof outputDir === "string" && outputDir.length > 0, "KiCad output directory is required");
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedTemplateDir = path.resolve(templateDir);
  const resolvedOutputDir = path.resolve(outputDir);
  workspaceRelativePath(resolvedWorkspaceRoot, resolvedTemplateDir);
  workspaceRelativePath(resolvedWorkspaceRoot, resolvedOutputDir);
  assert.ok(
    !isWithin(resolvedTemplateDir, resolvedOutputDir) && !isWithin(resolvedOutputDir, resolvedTemplateDir),
    "KiCad template and generated output directories must be separate and must not overlap",
  );
  const parameters = parseDesignSource({ schema_version: 1, parameters: design?.parameters });
  const validatedDesign = { parameters };
  assertRcSourceMapping({ design: validatedDesign, sourceManifest });

  const componentValues = {
    R1: parameters.resistance,
    C1: parameters.capacitance,
  };
  const generated = await Promise.all(
    NATIVE_KICAD_FILES.map(async (filename) => {
      const source = await readFile(path.join(resolvedTemplateDir, filename), "utf8");
      const contents = filename.endsWith(".kicad_sch")
        ? replaceComponentValues(source, "kicad_sch", "symbol", componentValues)
        : filename.endsWith(".kicad_pcb")
          ? replaceComponentValues(source, "kicad_pcb", "footprint", componentValues)
          : source;
      return [filename, contents];
    }),
  );

  await mkdir(resolvedOutputDir, { recursive: true });
  await assertOutputTargetsAreReplaceable(resolvedOutputDir);
  await Promise.all(generated.map(([filename, contents]) => publishGeneratedFile(resolvedOutputDir, filename, contents)));
  return { outputDir: resolvedOutputDir, files: [...NATIVE_KICAD_FILES], source_values: componentValues };
}
