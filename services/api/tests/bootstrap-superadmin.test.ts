import { describe, expect, it } from "vitest";
import {
  InitialSuperadminInputError,
  validateInitialSuperadminPassword,
} from "../src/bootstrap-superadmin.js";

describe("initial Superadmin password validation", () => {
  it("accepts a matching password meeting the required length", () => {
    expect(() =>
      validateInitialSuperadminPassword(
        "synthetic-only-password",
        "synthetic-only-password",
      ),
    ).not.toThrow();
  });

  it.each(["", "short"])("rejects a missing or weak password", (password) => {
    expect(() => validateInitialSuperadminPassword(password, password)).toThrow(
      InitialSuperadminInputError,
    );
  });

  it("rejects a mismatched confirmation without exposing either value", () => {
    const secret = "synthetic-only-password";
    let thrown: unknown;
    try {
      validateInitialSuperadminPassword(secret, "different-synthetic-value");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InitialSuperadminInputError);
    expect((thrown as Error).message).not.toContain(secret);
    expect((thrown as Error).message).not.toContain(
      "different-synthetic-value",
    );
  });

  it("rejects passwords that exceed the supported bound", () => {
    expect(() =>
      validateInitialSuperadminPassword("a".repeat(1_025), "a".repeat(1_025)),
    ).toThrow(InitialSuperadminInputError);
  });
});
