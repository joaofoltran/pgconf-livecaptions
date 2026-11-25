import assert from "node:assert/strict";
import { test } from "node:test";
import { nextPacedCaption } from "../public/caption-pace.js";

test("nextPacedCaption reveals one new word at a time", () => {
  let shown = "";
  shown = nextPacedCaption(shown, "one two three four");
  assert.equal(shown, "one");
  shown = nextPacedCaption(shown, "one two three four");
  assert.equal(shown, "one two");
  shown = nextPacedCaption(shown, "one two three four");
  assert.equal(shown, "one two three");
  shown = nextPacedCaption(shown, "one two three four");
  assert.equal(shown, "one two three four");
  assert.equal(nextPacedCaption(shown, "one two three four"), shown);
});

test("nextPacedCaption snaps back when the target shrinks or diverges", () => {
  assert.equal(nextPacedCaption("one two three", "one two"), "one two");
  assert.equal(nextPacedCaption("one two three", "one other three"), "one");
  assert.equal(nextPacedCaption("hello", ""), "");
});

test("nextPacedCaption treats punctuation-only changes as the same words", () => {
  assert.equal(nextPacedCaption("Hello world", "Hello world."), "Hello world.");
});
