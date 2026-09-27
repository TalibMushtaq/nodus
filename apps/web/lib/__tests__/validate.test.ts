import { describe, expect, it } from "vitest";

import {
  cleanDisplayName,
  isBlake3Hex,
  isIntegerString,
  MAX_DISPLAY_NAME_LENGTH,
  readJsonObject,
} from "../validate";

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body,
    headers,
  });
}

describe("readJsonObject", () => {
  it("parses a JSON object body", async () => {
    const result = await readJsonObject(jsonRequest('{"email":"a@b.com","password":"secret"}'));
    expect(result).toEqual({ ok: true, value: { email: "a@b.com", password: "secret" } });
  });

  it("treats an empty body as an empty object", async () => {
    const result = await readJsonObject(jsonRequest(""));
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("rejects a non-object JSON body", async () => {
    expect(await readJsonObject(jsonRequest("[1,2,3]"))).toMatchObject({ ok: false, status: 400 });
    expect(await readJsonObject(jsonRequest('"just a string"'))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects invalid JSON", async () => {
    expect(await readJsonObject(jsonRequest("{not json"))).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects a body over the Content-Length cap", async () => {
    const result = await readJsonObject(
      jsonRequest("{}", { "content-length": String(1024 * 1024) }),
      64 * 1024,
    );
    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects a chunked body over the cap even without Content-Length", async () => {
    const huge = `{"pad":"${"x".repeat(1000)}"}`;
    const result = await readJsonObject(jsonRequest(huge), 100);
    expect(result).toMatchObject({ ok: false, status: 413 });
  });
});

describe("isBlake3Hex", () => {
  it("accepts 64 hex chars and rejects everything else", () => {
    expect(isBlake3Hex("ab".repeat(32))).toBe(true);
    expect(isBlake3Hex("AB".repeat(32))).toBe(true);
    expect(isBlake3Hex("ab".repeat(31))).toBe(false);
    expect(isBlake3Hex("zz".repeat(32))).toBe(false);
    expect(isBlake3Hex(null)).toBe(false);
    expect(isBlake3Hex(42)).toBe(false);
  });
});

describe("cleanDisplayName", () => {
  it("trims and strips control characters", () => {
    expect(cleanDisplayName("  My Laptop  ")).toBe("My Laptop");
    expect(cleanDisplayName(`a${String.fromCharCode(0)}b`)).toBe("ab");
  });

  it("allows an empty string (clears the name)", () => {
    expect(cleanDisplayName("")).toBe("");
  });

  it("rejects non-strings and over-long names", () => {
    expect(cleanDisplayName(undefined)).toBeNull();
    expect(cleanDisplayName(7)).toBeNull();
    expect(cleanDisplayName("x".repeat(MAX_DISPLAY_NAME_LENGTH + 1))).toBeNull();
  });
});

describe("isIntegerString", () => {
  it("accepts digit strings only", () => {
    expect(isIntegerString("0")).toBe(true);
    expect(isIntegerString("12345")).toBe(true);
    expect(isIntegerString("-1")).toBe(false);
    expect(isIntegerString("1.5")).toBe(false);
    expect(isIntegerString("")).toBe(false);
    expect(isIntegerString(null)).toBe(false);
  });
});
