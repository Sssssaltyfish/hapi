# AGY gateway model discovery

Use AGY's supported gateway mode when a Gemini-compatible gateway supplies its
own model catalog. Setting only `GOOGLE_GEMINI_BASE_URL` redirects requests but
leaves AGY in its Gemini API-key mode, with a different model catalog.

This is optional provider setup; HAPI and Tailscale do not require a particular
model gateway. AGY 1.5.7 was verified. See Google's
[gateway connection documentation](https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools/connect-enterprise-gateway?hl=en).

1. Install `agy-gateway.sh` as `~/.local/bin/agy-cpa`, keeping the upstream AGY
   executable at `~/.local/bin/agy`. Make the wrapper executable. Updates to AGY
   then replace its executable without overwriting the wrapper.
2. Copy `agy-gateway.example.env` to `~/.config/hapi/agy-gateway.env`. Use your own
   gateway URL and credential file. Restrict these local files to your user.
   Credentials and real endpoints must not be included in a distribution package.
3. If migrating from Gemini API-key mode, inspect the AGY settings file reported
   by your installation (`~/.gemini/antigravity-cli/settings.json` in the verified
   version). Remove the `modelProvider: "gemini"` setting. Preserve other settings.
   Before switching, use `agy-cpa --output-format=json models` to map the current
   model's display name to its `id`, and store that id as `model`. Gateway labels
   can differ; an exact id preserves the intended default and effort.
4. Run `agy-cpa --output-format=json models` to verify discovery. For an OpenAI
   gateway, use `AGY_LLM_GATEWAY_WIRE_PROTOCOL='openai'` and its corresponding URL.
5. Point HAPI's existing AGY command override at `~/.local/bin/agy-cpa`, or put an
   `agy` shim that execs that wrapper ahead of the upstream binary in the runner's
   PATH. Start a new AGY session to apply the changed process environment.

HAPI reads the returned model ids and derives effort choices from the advertised
variants. It refreshes stale catalogs when opening the model/effort picker or
entering the session creation page. The refresh icon beside Model forces a new
lookup. There is no periodic catalog polling while a page stays open.
