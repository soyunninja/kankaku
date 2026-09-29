// Test bootstrap, loaded before any test file through `--import` (see the
// `test` script in package.json).
//
// Ink's colour output depends on the environment: on a real TTY, or with
// COLORTERM/FORCE_COLOR set, `ink-testing-library`'s `lastFrame()` carries
// ANSI colour codes; in a plain pipe it does not. The screen tests assert
// on plain text (`█████░░░░░`, `› Tasks`, `╭─[ Today ]`), so colour must be
// off for every run, whoever runs it. chalk/supports-color read these
// variables when they are first imported, which is why this runs before
// tsx loads the test files.
process.env.FORCE_COLOR = "0";
process.env.NO_COLOR = "1";
delete process.env.COLORTERM;
