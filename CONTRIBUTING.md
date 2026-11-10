# Contributing

Thanks for helping. The most useful contribution is a real query the guard gets wrong.

## Report a query

Open an issue with the "Query handled wrong" template. Include:

- the query (rename private tables if you need to)
- the options you passed
- what you expected (accept or reject) and what happened

## Send a fix

1. Fork and clone the repo. You need Node 18 or newer; there are no dependencies to install.
2. Add a test in `test/check.test.js` that fails without your change.
3. Make the change in `src/`.
4. Run `npm test`.
5. Open a pull request that says what was wrong and how you fixed it.

## Ground rules

- The guard should fail safe: when unsure whether a query writes data or reads a disallowed dataset, reject it with a clear message.
- Messages are shown to people and fed back to models, so keep them short and plain.
- No runtime dependencies.

Look for issues labelled `good first issue` if you want somewhere to start.
