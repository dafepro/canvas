import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

const wireSignatures = (proto: string): Set<string> => {
  const signatures = new Set<string>();
  let scope = "";
  let kind: "message" | "enum" | "" = "";
  let oneof = "";
  for (const sourceLine of proto.split(/\r?\n/u)) {
    const line = sourceLine.replace(/\/\/.*$/u, "").trim();
    const declaration = line.match(/^(message|enum)\s+(\w+)\s*\{/u);
    if (declaration) {
      kind = declaration[1] as "message" | "enum";
      scope = declaration[2]!;
      oneof = "";
      continue;
    }
    const oneofDeclaration = line.match(/^oneof\s+(\w+)\s*\{/u);
    if (oneofDeclaration) {
      oneof = oneofDeclaration[1]!;
      continue;
    }
    if (line === "}") {
      if (oneof) oneof = "";
      else {
        scope = "";
        kind = "";
      }
      continue;
    }
    if (kind === "message") {
      const reserved = line.match(/^reserved\s+(.+);$/u);
      if (reserved) {
        for (const number of reserved[1]!.split(",").map((value) => value.trim())) {
          signatures.add(`R:${scope}:${number}`);
        }
        continue;
      }
      const field = line.match(/^(repeated\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)\s*;/u);
      if (field) {
        const label = field[1] ? "repeated" : "optional";
        signatures.add(
          `M:${scope}:${field[4]}:${label}:${field[2]}:${field[3]}` +
          (oneof ? `:oneof=${oneof}` : ""),
        );
      }
    } else if (kind === "enum") {
      const value = line.match(/^(\w+)\s*=\s*(-?\d+)\s*;/u);
      if (value) signatures.add(`E:${scope}:${value[2]}:${value[1]}`);
    }
  }
  return signatures;
};

describe("protocol v8 wire compatibility", () => {
  it("preserves every released field, oneof, enum value, and reservation", () => {
    const version = read("packages/protocol/src/version.ts").match(
      /PROTOCOL_VERSION\s*=\s*(\d+)/u,
    )?.[1];
    const baseline = read(`packages/protocol/proto/wire-contract.v${version}.txt`)
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const current = wireSignatures(read("packages/protocol/proto/room.proto"));

    expect(baseline.length).toBeGreaterThan(0);
    for (const signature of baseline) {
      expect(current, `released wire declaration changed: ${signature}`).toContain(signature);
    }
  });
});
