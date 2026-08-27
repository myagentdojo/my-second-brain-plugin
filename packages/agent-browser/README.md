# Agent Browser package

This private workspace package owns the bounded Playwright and installed-Chrome
compatibility proof. Warm Browser remains unimplemented and absent from the
runtime catalog.

## Real Chrome compatibility proof

Ordinary `bun test` and an unacknowledged proof command must not launch Chrome.
After reviewing the fixture boundary, run one compatibility proof with the
repository-pinned Bun 1.4.0:

```sh
AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 bun run prove:agent-browser-cdp -- --run-id <ID>
```

The acknowledgment applies only to that process. The package script does not
set it. The proof launches installed stable Google Chrome with a disposable
profile, an explicit loopback CDP endpoint, basic password storage, and Chrome's
mock keychain. It does not use the Agent Chrome Profile or download a browser.

The failure and cleanup fixture is separately selected through Bun's test
filter and requires the same environment acknowledgment:

```sh
AGENT_BROWSER_CDP_FIXTURE_ACKNOWLEDGED=1 bun test packages/agent-browser/scripts/prove-cdp-compatibility.test.ts --test-name-pattern close-before-connect
```
