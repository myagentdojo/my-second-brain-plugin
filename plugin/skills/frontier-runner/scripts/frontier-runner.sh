#!/usr/bin/env bash

set -euo pipefail

usage() {
	cat <<'EOF'
Usage: frontier-runner.sh [workspace]

Outside Herdr, attach Ghostty to the frontier-runner-v0 session. Inside a
managed Herdr pane, open Terminal Code on the calling pane's foreground cwd in
a right-hand Herdr pane. Outside Herdr, the workspace defaults to the current
directory.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
	usage
	exit 0
fi

if (( $# > 1 )); then
	printf 'error: expected zero or one workspace path\n' >&2
	printf 'repair: run frontier-runner.sh --help\n' >&2
	exit 2
fi

if [[ "${HERDR_ENV:-}" == "1" ]]; then
	if [[ -z "${HERDR_PANE_ID:-}" ]]; then
		printf 'error: HERDR_PANE_ID is missing in the managed pane\n' >&2
		printf 'repair: invoke from a Herdr-managed pane process\n' >&2
		exit 1
	fi
	for command_name in herdr jq tode; do
		if ! command -v "$command_name" >/dev/null 2>&1; then
			printf 'error: required command is missing: %s\n' "$command_name" >&2
			printf 'repair: install or expose %s on PATH, then retry\n' "$command_name" >&2
			exit 1
		fi
	done
	if ! pane_json="$(herdr pane current --current)"; then
		printf 'error: Herdr could not resolve the calling pane\n' >&2
		printf 'repair: run from a live Herdr pane and retry\n' >&2
		exit 1
	fi
	if ! pane_id="$(printf '%s\n' "$pane_json" | jq -er '.result.pane.pane_id | select(type == "string" and length > 0)' 2>/dev/null)"; then
		printf 'error: Herdr returned no calling pane id\n' >&2
		printf 'repair: inspect herdr pane current --current\n' >&2
		exit 1
	fi
	if ! workspace_input="$(printf '%s\n' "$pane_json" | jq -er '.result.pane.foreground_cwd | select(type == "string" and length > 0)' 2>/dev/null)"; then
		printf 'error: Herdr returned no foreground cwd for pane %s\n' "$pane_id" >&2
		printf 'repair: use a pane whose foreground process cwd Herdr can resolve\n' >&2
		exit 1
	fi
	if [[ ! -d "$workspace_input" ]]; then
		printf 'error: managed pane workspace is not a directory: %s\n' "$workspace_input" >&2
		printf 'repair: use a pane with an existing foreground cwd\n' >&2
		exit 1
	fi
	workspace="$(cd -- "$workspace_input" && pwd -P)"
	if (( $# == 1 )); then
		if [[ ! -d "$1" ]]; then
			printf 'error: workspace is not a directory: %s\n' "$1" >&2
			printf 'repair: pass an existing directory\n' >&2
			exit 2
		fi
		requested_workspace="$(cd -- "$1" && pwd -P)"
		if [[ "$requested_workspace" != "$workspace" ]]; then
			printf 'error: workspace argument does not match managed pane: %s\n' "$workspace" >&2
			printf 'repair: omit the argument or invoke from the intended Herdr pane\n' >&2
			exit 2
		fi
	fi
	if ! split_json="$(herdr pane split --current --direction right --cwd "$workspace" --no-focus)"; then
		printf 'error: Herdr could not create the Terminal Code pane\n' >&2
		printf 'repair: inspect the current pane layout and retry\n' >&2
		exit 1
	fi
	if ! editor_pane_id="$(printf '%s\n' "$split_json" | jq -er '.result.pane.pane_id | select(type == "string" and length > 0)' 2>/dev/null)"; then
		printf 'error: Herdr returned no Terminal Code pane id\n' >&2
		printf 'repair: inspect herdr pane split output\n' >&2
		exit 1
	fi
	if ! herdr pane run "$editor_pane_id" 'exec tode .' >/dev/null; then
		printf 'error: Herdr could not start Terminal Code in pane %s\n' "$editor_pane_id" >&2
		printf 'repair: verify tode is available to the managed pane shell\n' >&2
		exit 1
	fi
	printf 'editor=terminal-code\n'
	printf 'pane=%s\n' "$pane_id"
	printf 'editor_pane=%s\n' "$editor_pane_id"
	printf 'workspace=%s\n' "$workspace"
	printf 'next=start or resume one bounded worker in this Herdr workspace\n'
	exit 0
fi

workspace_input="${1:-$PWD}"
if [[ ! -d "$workspace_input" ]]; then
	printf 'error: workspace is not a directory: %s\n' "$workspace_input" >&2
	printf 'repair: pass an existing directory\n' >&2
	exit 2
fi
workspace="$(cd -- "$workspace_input" && pwd -P)"

for command_name in herdr open; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		printf 'error: required command is missing: %s\n' "$command_name" >&2
		printf 'repair: install or expose %s on PATH, then retry\n' "$command_name" >&2
		exit 1
	fi
done

if ! open -Ra Ghostty.app >/dev/null 2>&1; then
	printf 'error: Ghostty.app is unavailable\n' >&2
	printf 'repair: install Ghostty or make the app visible to macOS\n' >&2
	exit 1
fi

session='frontier-runner-v0'
open -na Ghostty.app --args "--working-directory=$workspace" -e herdr --session "$session"

printf 'session=%s\n' "$session"
printf 'workspace=%s\n' "$workspace"
printf 'next=run frontier-runner again inside the managed pane to open Terminal Code\n'
