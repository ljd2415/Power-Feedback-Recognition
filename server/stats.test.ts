import test from "node:test";
import assert from "node:assert/strict";
import { calculateRate } from "./stats.js";

test("同比环比变化率采用统一公式", () => {
  assert.equal(calculateRate(130, 100), 30);
  assert.equal(calculateRate(70, 100), -30);
});

test("零基期规则", () => {
  assert.equal(calculateRate(0, 0), 0);
  assert.equal(calculateRate(5, 0), null);
});
