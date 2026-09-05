// Conventional Commits. The value is not tidiness: the type prefix is what lets a reader
// scan `git log --oneline` and tell a behaviour change from a rename, which matters most
// in exactly the situation where history is being read under pressure.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // The default 100 is tight for a scoped subject like
    // "refactor(backend): ..." on a repo with descriptive commit subjects.
    "header-max-length": [2, "always", 120],
    "body-max-line-length": [0],
  },
};
