// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert");
const X = require("../archive_viewer/export.js");

const at = (day, h, min) => new Date(2026, 9, day, h, min).getTime();
const people = { a: { name: "Alex Demo", me: true }, b: { name: "Jamie Rivera" }, c: { name: "ナナ🌻" } };

function chat(messages, extra) {
  return Object.assign({ title: "Jamie Rivera", group: false, people, messages: messages.map((m, i) => Object.assign({ id: "m" + i, s: "b", type: "TEXT" }, m)) }, extra);
}

const lines = (data, opts) => X.build(data, opts).text.split("\n").filter((l) => !/^(Instagram chat|Names|Key):/.test(l));

test("lines carry a short name, text and a day header", () => {
  const out = lines(chat([{ t: at(1, 9, 0), s: "a", me: true, text: "hi" }, { t: at(1, 9, 1), text: "hello\nthere" }]));
  assert.deepStrictEqual(out.slice(0, 4), ["# 2026-10-01", "09:00 Me: hi", "Jamie: hello", "  there"]);
});

test("times appear again only after ten minutes", () => {
  const out = lines(chat([{ t: at(1, 9, 0), text: "a" }, { t: at(1, 9, 9), text: "b" }, { t: at(1, 9, 10), text: "c" }]));
  assert.deepStrictEqual(out.slice(1, 4), ["09:00 Jamie: a", "Jamie: b", "09:10 Jamie: c"]);
  assert.match(lines(chat([{ t: at(1, 9, 0), text: "a" }, { t: at(1, 9, 1), text: "b" }]), { times: "every" })[2], /^09:01 /);
  assert.doesNotMatch(lines(chat([{ t: at(1, 9, 0), text: "a" }]), { times: "none" })[1], /^\d\d:/);
});

test("a replied-to message gets an id and the reply points at it", () => {
  const data = chat([{ t: at(1, 9, 0), text: "dinner?" }, { t: at(1, 9, 1), text: "ok", s: "a", me: true, reply: { id: "m0", sender: "Jamie Rivera", text: "dinner?" } }]);
  assert.deepStrictEqual(lines(data).slice(1, 3), ["09:00 #1 Jamie: dinner?", "Me ↩1: ok"]);
});

test("a reply to a message outside the range quotes it instead", () => {
  const data = chat([{ t: at(1, 9, 0), text: "dinner?" }, { t: at(5, 9, 0), text: "ok", s: "a", me: true, reply: { id: "m0", sender: "Jamie Rivera", text: "dinner?" } }]);
  const out = lines(data, { from: at(5, 0, 0) });
  assert.strictEqual(out[1], '09:00 Me ↩(Jamie: "dinner?"): ok');
});

test("every message can be numbered", () => {
  const out = lines(chat([{ t: at(1, 9, 0), text: "a" }, { t: at(1, 9, 1), text: "b" }]), { ids: true });
  assert.deepStrictEqual(out.slice(1, 3), ["09:00 #1 Jamie: a", "#2 Jamie: b"]);
});

test("reactions, reels, attachments and events", () => {
  const data = chat([
    { t: at(1, 9, 0), text: "lol", react: [["😂", "You"], ["😂", "Jamie Rivera"], ["❤", "Jamie Rivera"]] },
    { t: at(1, 9, 1), type: "MESSAGE_INLINE_SHARE", share: { decoration: "REEL", account: "foo", caption: "foo A fun reel #fyp #viral", link: "https://www.instagram.com/reel/X/?id=1" }, att: [["thumbnail", "t.jpg"]] },
    { t: at(1, 9, 2), att: [["image", "a.jpg"], ["image", "b.jpg"], ["audio", "v.mp4"]] },
    { t: at(1, 9, 3), activity: "You started a video chat", ak: "event" },
    { t: at(1, 9, 4), activity: "x wasn't notified about this message because they're in quiet mode.", ak: "event" },
    { t: at(1, 9, 5), ak: "reaction", activity: "Reacted" },
    { t: at(1, 9, 6), type: "IMAGES" },
  ]);
  assert.deepStrictEqual(lines(data).slice(1, 6), [
    "09:00 Jamie: lol {😂 Me,Jamie; ❤ Jamie}",
    "Jamie: [reel @foo: A fun reel]",
    "Jamie: [2 photos] [voice]",
    "* You started a video chat",
    "Jamie: [photo]",
  ]);
  const withLinks = lines(data, { links: true, captions: "none" })[2];
  assert.strictEqual(withLinks, "Jamie: [reel @foo https://www.instagram.com/reel/X/]");
});

test("names fall back to letters when they are not plain Latin", () => {
  const data = chat([{ t: at(1, 9, 0), s: "c", text: "hi" }], { title: "ナナ🌻" });
  const text = X.build(data).text;
  assert.match(text, /^Names: Me=you, Alex Demo; A=ナナ🌻$/m);
  assert.match(text, /09:00 A: hi/);
});

test("the range is inclusive and an empty range still produces a header", () => {
  const data = chat([{ t: at(1, 9, 0), text: "a" }, { t: at(2, 9, 0), text: "b" }]);
  assert.strictEqual(X.build(data, { from: at(2, 0, 0), to: at(2, 23, 59) }).messages, 1);
  const none = X.build(data, { from: at(9, 0, 0) });
  assert.strictEqual(none.messages, 0);
  assert.match(none.text, /no messages in this range/);
});

test("token estimate grows with text and counts digits, emoji and other scripts higher", () => {
  assert.strictEqual(X.estimateTokens(""), 0);
  assert.ok(X.estimateTokens("hello world, how are you doing today") < 15);
  assert.ok(X.estimateTokens("2026-10-31") >= 8);
  assert.ok(X.estimateTokens("😂😂😂😂") >= 5);
  assert.ok(X.estimateTokens("शुभ रात्रि") > X.estimateTokens("good night"));
});
