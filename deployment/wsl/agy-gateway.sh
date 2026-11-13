#!/bin/sh
# Keep this wrapper separate from the AGY binary managed by its updater.
set -eu
set +x

config="${AGY_GATEWAY_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/hapi/agy-gateway.env}"
if [ -f "$config" ]; then
    . "$config"
fi
: "${AGY_LLM_GATEWAY_URL:?Set the gateway URL in agy-gateway.env}"
if [ -n "${AGY_LLM_GATEWAY_API_KEY_FILE:-}" ]; then
    AGY_LLM_GATEWAY_API_KEY=$(cat -- "$AGY_LLM_GATEWAY_API_KEY_FILE")
fi
: "${AGY_LLM_GATEWAY_API_KEY:?Set a gateway API key or API key file}"
AGY_LLM_GATEWAY_WIRE_PROTOCOL="${AGY_LLM_GATEWAY_WIRE_PROTOCOL:-genai}"
export AGY_LLM_GATEWAY_URL AGY_LLM_GATEWAY_API_KEY AGY_LLM_GATEWAY_WIRE_PROTOCOL
unset GEMINI_API_KEY GOOGLE_GEMINI_BASE_URL
exec "${AGY_BINARY:-$HOME/.local/bin/agy}" "$@"
