# Tab Capability: botDetection
Reports when a cloud browser task is blocked by bot detection, CAPTCHA, hard access denial, or a repeated challenge loop.

## Bot Detection Reporting
Use this capability only when the current cloud browser tab is blocked by
bot-detection, anti-automation, human-verification, or related access-control
systems. Report the blocker after you have enough page evidence to classify it,
then stop or continue according to the surrounding Browser Safety guidance.

### Choose The Reason
- `captcha_failed`: Use after you attempted a CAPTCHA or human-verification
  challenge with the user's permission, but the site rejected the attempt or
  the challenge still blocks progress.
- `access_denied`: Use for hard access blocks such as 403, Access Denied,
  request blocked, forbidden, bot traffic denied, or policy-denied pages that
  do not present an interactive challenge.
- `challenge_loop`: Use when the site repeatedly reloads, loops through a
  challenge, sends you back to the same login or verification page, or never
  reaches the intended content after reasonable attempts.
- `unexpected_bot_error`: Use for bot-related failures that do not fit the
  above categories, such as an anti-bot script crash, blocked browser feature,
  or unexplained automation-detection error.

Use the most specific matching value. Do not invent a free-form reason.

```js
var botDetection = await tab.capabilities.get("botDetection");
var reportResult = await botDetection.report({
  reason: "captcha_failed",
});
nodeRepl.write(reportResult);
```

## API Reference
```ts
const capability = await tab.capabilities.get("botDetection");

interface BotDetectionTabCapability {
  report(options: { reason: "captcha_failed" | "access_denied" | "challenge_loop" | "unexpected_bot_error" }): Promise<{ hostname: null | string; status: "reported" }>; // Report the currently open page as blocked by bot detection. The runtime records only the parsed hostname, never the full URL.
}
```
