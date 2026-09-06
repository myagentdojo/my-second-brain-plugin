#!/bin/sh
# Generated from runtime/skill-catalog.json. Edit the source, then run bun run generate.
runtime_catalog_select_skill() {
	case "$1" in
	agent-browser)
		RUNTIME_SKILL_ENTRY='runtime/warm-browser.js'
		RUNTIME_SKILL_PROFILE='bun'
		RUNTIME_SKILL_COMPILED_TARGET=''
		;;
	frontier-runner)
		RUNTIME_SKILL_ENTRY='runtime/frontier-runner.js'
		RUNTIME_SKILL_PROFILE='bun'
		RUNTIME_SKILL_COMPILED_TARGET=''
		;;
	hello-world)
		RUNTIME_SKILL_ENTRY='runtime/hello-world.js'
		RUNTIME_SKILL_PROFILE='bun'
		RUNTIME_SKILL_COMPILED_TARGET=''
		;;
	skill-a)
		RUNTIME_SKILL_ENTRY='runtime/skill-a.js'
		RUNTIME_SKILL_PROFILE='bun'
		RUNTIME_SKILL_COMPILED_TARGET='darwin-arm64'
		;;
	skill-b)
		RUNTIME_SKILL_ENTRY='runtime/skill-b.js'
		RUNTIME_SKILL_PROFILE='bun'
		RUNTIME_SKILL_COMPILED_TARGET=''
		;;
	*) return 1 ;;
	esac
}
