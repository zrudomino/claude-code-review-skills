// router-cases.js — regression cases for lib/router.js detectReviewTask (12 cases).
// Added 2026-11-09 with the review-scope fix (item I). Run from the repo root:
//   node codex-agent/tests/router-cases.js codex-agent/lib/router.js codex-agent/tests/fixtures/diff-181b334.txt codex-agent/tests/fixtures/diff-9ba2e9b-dispatch.txt
// Fixtures: `git show 181b334 -- codex-agent/lib/parse-output.js` and
// `git show 9ba2e9b -- codex-agent/commands/dispatch.md` (the latter mentions "review" 36 times).
// Expected output: "all ok" and "extra all ok".
var r = require(require("path").resolve(process.argv[2])), fs = require('fs');
var dA = fs.readFileSync(process.argv[3], 'utf-8'), dB = fs.readFileSync(process.argv[4], 'utf-8');
var cases = [
  ['Stage 3 + pasted diff',             'Adversarial code review of this diff. Be skeptical, thorough, and find bugs that a normal review would miss. ' + dA + '\nReport findings with severity, file, line, description, and suggested fix.', 'focused'],
  ['bare "review my changes"',          'review my changes', 'pure'],
  ['bare "code review of the diff"',    'Do a code review of the diff before I push', 'pure'],
  ['Skeptic (new template)',            'Focused code review of codex-agent/lib/parse-output.js to verify these findings: negative cost delta. ' + dA + ' Report findings with severity, file, line, description, and suggested fix.', 'focused'],
  ['review named commit',               'Code review of commit 181b334 please', 'focused'],
  ['review PR',                         'review PR #42', 'focused'],
  ['f&v tester, diff without "review"', 'You are an adversarial tester. Your goal is to find ways the fix is WRONG. Write tests that try to BREAK the fix. ' + dA, 'task'],
  ['f&v tester, diff WITH "review"',    'You are an adversarial tester. Your goal is to find ways the fix is WRONG. Write tests that try to BREAK the fix. ' + dB, 'task'],
  ['task: implement a review system',   'implement a review system for the admin page', 'task']
];
var bad = 0;
cases.forEach(function (c) { var d = r.detectReviewTask(c[1]); var got = !d.isReview ? 'task' : (d.isFocused ? 'focused' : 'pure'); if (got !== c[2]) bad++;
  console.log((got === c[2] ? 'ok  ' : 'FAIL') + ' ' + c[0].padEnd(36) + ' expect=' + c[2].padEnd(7) + ' got=' + got.padEnd(7) + ' ' + JSON.stringify(d.signals)); });
console.log(bad ? bad + ' FAILED' : 'all ok');
var extra = [
  ['f&v tester + pasted source w/ review', 'You are an adversarial tester. Write tests that try to BREAK the fix.\nSource after fix:\n// performs a code review of the payload\nfunction review(x){ return x; }', 'task'],
  ['Stage 3, diff contains "Write tests"', 'Adversarial code review of this diff.\ndiff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1,1 +1,2 @@\n line\n+Write tests that try to BREAK the fix\nReport findings with severity.', 'focused'],
  ['review with fenced code block',     'Please review this snippet for bugs:\n```js\n// write tests later\nvar a = 1;\n```', 'focused']
];
var bad2 = 0;
extra.forEach(function (c) { var d = r.detectReviewTask(c[1]); var got = !d.isReview ? 'task' : (d.isFocused ? 'focused' : 'pure'); if (got !== c[2]) bad2++;
  console.log((got === c[2] ? 'ok  ' : 'FAIL') + ' ' + c[0].padEnd(36) + ' expect=' + c[2].padEnd(7) + ' got=' + got.padEnd(7) + ' ' + JSON.stringify(d.signals)); });
console.log(bad2 ? bad2 + ' extra FAILED' : 'extra all ok');
